// @effect-diagnostics nodeBuiltinImport:off - the supervisor owns raw HTTP and needs a hard timeout.
import * as NodeOS from "node:os";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { decodeJarvisSemanticProposal } from "@t3tools/jarvis-core/command";

import { JARVIS_FAST_SUPERVISOR_SYSTEM_PROMPT } from "../Services/JarvisFastSupervisor.ts";
import {
  JARVIS_CODEX_OAUTH_CLIENT_ID,
  JARVIS_CODEX_OAUTH_SCOPE,
  JARVIS_CODEX_ORIGINATOR,
  JARVIS_CODEX_RESPONSES_ENDPOINT,
  JARVIS_CODEX_SUPERVISOR_DEFAULT_MODEL,
  JARVIS_CODEX_SUPERVISOR_MAX_PROMPT_CHARS,
  JARVIS_CODEX_TOKEN_ENDPOINT,
  JarvisCodexSupervisor,
  buildJarvisCodexResponsesBody,
  extractJarvisCodexJsonObject,
  interpretJarvisCodexSseEvent,
  isJarvisCodexCredentialFresh,
  mergeJarvisCodexRefreshedAuth,
  parseJarvisCodexAuth,
  type JarvisCodexCredentials,
  type JarvisCodexSupervisorAvailability,
  type JarvisCodexSupervisorOutcome,
  type ParsedJarvisCodexAuth,
} from "../Services/JarvisCodexSupervisor.ts";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_REFRESH_SKEW_MS = 60_000;
const MAX_RESPONSE_BYTES = 4_000_000;

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonSync = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface ResolvedCodexAuth {
  readonly at: number;
  readonly filePath: string | null;
  readonly credentials: JarvisCodexCredentials | null;
}

export interface JarvisCodexSupervisorLiveOptions {
  /** Explicit auth file candidates; `JARVIS_CODEX_AUTH_FILE` and defaults still rank first. */
  readonly authFiles?: ReadonlyArray<string>;
  readonly endpoint?: string;
  readonly tokenEndpoint?: string;
  readonly originator?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly refreshSkewMs?: number;
  readonly homeDirectory?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Direct supervisor over the ChatGPT Codex Responses backend. Disabled
 * behavior is a decline, so a machine without Codex auth keeps the fx tier and
 * the ordinary provider supervisor with no added latency beyond one cached
 * auth read.
 */
export const makeJarvisCodexSupervisorLive = (
  options: JarvisCodexSupervisorLiveOptions = {},
): Layer.Layer<JarvisCodexSupervisor, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    JarvisCodexSupervisor,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const doFetch = options.fetchImpl ?? fetch;
      const endpoint = options.endpoint ?? JARVIS_CODEX_RESPONSES_ENDPOINT;
      const tokenEndpoint = options.tokenEndpoint ?? JARVIS_CODEX_TOKEN_ENDPOINT;
      const originator = options.originator ?? JARVIS_CODEX_ORIGINATOR;
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
      const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
      const homeDirectory = options.homeDirectory ?? NodeOS.homedir();
      const model =
        options.model?.trim() ||
        process.env.JARVIS_CODEX_SUPERVISOR_MODEL?.trim() ||
        JARVIS_CODEX_SUPERVISOR_DEFAULT_MODEL;

      const authFileCandidates = (): ReadonlyArray<string> => {
        const seen = new Set<string>();
        const ordered: string[] = [];
        const push = (value: string | undefined): void => {
          const trimmed = value?.trim() ?? "";
          if (trimmed.length === 0 || seen.has(trimmed)) return;
          seen.add(trimmed);
          ordered.push(trimmed);
        };
        push(process.env.JARVIS_CODEX_AUTH_FILE);
        for (const candidate of options.authFiles ?? []) push(candidate);
        if (homeDirectory.length > 0) {
          push(path.join(homeDirectory, ".codex", "auth.json"));
          push(path.join(homeDirectory, ".fx", "chatgpt-auth.json"));
        }
        return ordered;
      };

      const readAuthFile = (filePath: string) =>
        fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));

      const writeAuthFile = (filePath: string, text: string) =>
        fs.writeFileString(filePath, text).pipe(Effect.orElseSucceed(() => undefined));

      const refreshCredentials = (
        filePath: string,
        parsed: ParsedJarvisCodexAuth,
        original: unknown,
      ): Effect.Effect<JarvisCodexCredentials | null> =>
        Effect.gen(function* () {
          const refreshToken = parsed.credentials.refreshToken;
          if (refreshToken === undefined) return null;
          const body = new URLSearchParams({
            client_id: JARVIS_CODEX_OAUTH_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            scope: JARVIS_CODEX_OAUTH_SCOPE,
          });
          const response = yield* Effect.tryPromise({
            try: () =>
              doFetch(tokenEndpoint, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: body.toString(),
                signal: AbortSignal.timeout(timeoutMs),
              }),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          if (response === null || !response.ok) return null;
          const payload = yield* Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          if (payload === null || typeof payload !== "object") return null;
          const record = payload as Record<string, unknown>;
          const accessToken =
            typeof record["access_token"] === "string" ? record["access_token"] : null;
          if (accessToken === null) return null;
          const refreshTokenNext =
            typeof record["refresh_token"] === "string" ? record["refresh_token"] : undefined;
          const idToken = typeof record["id_token"] === "string" ? record["id_token"] : undefined;
          const expiresIn =
            typeof record["expires_in"] === "number" &&
            Number.isFinite(record["expires_in"]) &&
            record["expires_in"] > 0
              ? record["expires_in"]
              : undefined;
          const nowDateTime = yield* DateTime.now;
          const expiresAtMs =
            expiresIn === undefined
              ? undefined
              : DateTime.toEpochMillis(nowDateTime) + expiresIn * 1000;
          const merged = mergeJarvisCodexRefreshedAuth({
            shape: parsed.shape,
            original,
            accessToken,
            ...(refreshTokenNext === undefined ? {} : { refreshToken: refreshTokenNext }),
            ...(idToken === undefined ? {} : { idToken }),
            ...(parsed.credentials.accountId === undefined
              ? {}
              : { accountId: parsed.credentials.accountId }),
            ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
            refreshedAtIso: DateTime.formatIso(nowDateTime),
          });
          yield* writeAuthFile(filePath, `${encodeUnknownJson(merged)}\n`);
          return {
            accessToken,
            refreshToken: refreshTokenNext ?? refreshToken,
            ...(parsed.credentials.accountId === undefined
              ? {}
              : { accountId: parsed.credentials.accountId }),
            ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
          } satisfies JarvisCodexCredentials;
        });

      const cacheRef = yield* Ref.make<ResolvedCodexAuth | null>(null);
      const resolveSemaphore = yield* Semaphore.make(1);

      const resolveUncached = Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        for (const filePath of authFileCandidates()) {
          const text = yield* readAuthFile(filePath);
          if (text === null) continue;
          const json = yield* decodeUnknownJson(text).pipe(Effect.orElseSucceed(() => null));
          if (json === null) continue;
          const parsed = parseJarvisCodexAuth(json);
          if (parsed === null) continue;
          let credentials = parsed.credentials;
          if (!isJarvisCodexCredentialFresh(credentials, nowMs, refreshSkewMs)) {
            const refreshed = yield* refreshCredentials(filePath, parsed, json);
            if (refreshed !== null) credentials = refreshed;
          }
          const entry: ResolvedCodexAuth = { at: nowMs, filePath, credentials };
          yield* Ref.set(cacheRef, entry);
          return entry;
        }
        const entry: ResolvedCodexAuth = { at: nowMs, filePath: null, credentials: null };
        yield* Ref.set(cacheRef, entry);
        return entry;
      });

      const resolve = Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const cached = yield* Ref.get(cacheRef);
        if (cached !== null && nowMs - cached.at < cacheTtlMs) return cached;
        return yield* resolveSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const rechecked = yield* Ref.get(cacheRef);
            const recheckedNowMs = DateTime.toEpochMillis(yield* DateTime.now);
            if (rechecked !== null && recheckedNowMs - rechecked.at < cacheTtlMs) return rechecked;
            return yield* resolveUncached;
          }),
        );
      });

      const interpret = (input: {
        readonly prompt: string;
        readonly model?: string;
      }): Effect.Effect<JarvisCodexSupervisorOutcome> =>
        Effect.gen(function* () {
          const prompt = input.prompt;
          if (
            prompt.trim().length === 0 ||
            prompt.length > JARVIS_CODEX_SUPERVISOR_MAX_PROMPT_CHARS
          ) {
            return { status: "decline", reason: "codex-supervisor-error" } as const;
          }
          const resolved = yield* resolve;
          const credentials = resolved.credentials;
          if (credentials === null) {
            return { status: "decline", reason: "codex-supervisor-unauthenticated" } as const;
          }
          const selectedModel = input.model?.trim() || model;
          const body = buildJarvisCodexResponsesBody({
            model: selectedModel,
            prompt,
            instructions: JARVIS_FAST_SUPERVISOR_SYSTEM_PROMPT,
          });
          const response = yield* Effect.tryPromise({
            try: () =>
              doFetch(endpoint, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${credentials.accessToken}`,
                  ...(credentials.accountId === undefined
                    ? {}
                    : { "chatgpt-account-id": credentials.accountId }),
                  originator,
                  "OpenAI-Beta": "responses=experimental",
                  accept: "text/event-stream",
                  "content-type": "application/json",
                },
                body: encodeUnknownJson(body),
                signal: AbortSignal.timeout(timeoutMs),
              }),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          if (response === null) {
            yield* Effect.logWarning(
              "ARIS codex supervisor request failed or timed out; falling back.",
            );
            return { status: "decline", reason: "codex-supervisor-timeout" } as const;
          }
          if (!response.ok) {
            const detail = yield* Effect.tryPromise({
              try: () => response.text(),
              catch: () => null,
            }).pipe(Effect.orElseSucceed(() => null));
            yield* Effect.logDebug(
              `ARIS codex supervisor HTTP ${response.status}: ${(detail ?? "").slice(0, 200)}`,
            );
            return { status: "decline", reason: "codex-supervisor-error" } as const;
          }
          const streamed = yield* readJarvisCodexStream(response);
          if (streamed === null) {
            return { status: "decline", reason: "codex-supervisor-malformed" } as const;
          }
          const raw = extractJarvisCodexJsonObject(streamed);
          if (raw === null) {
            return { status: "decline", reason: "codex-supervisor-malformed" } as const;
          }
          const proposal = yield* Effect.try({
            try: () => decodeJarvisSemanticProposal(raw),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          if (proposal === null) {
            return { status: "decline", reason: "codex-supervisor-malformed" } as const;
          }
          return { status: "proposal", proposal } as const;
        });

      return {
        availability: resolve.pipe(
          Effect.map((resolved): JarvisCodexSupervisorAvailability =>
            resolved.credentials === null ? { available: false } : { available: true, model },
          ),
        ),
        interpret,
      };
    }),
  );

/**
 * Read the SSE body until completion, keeping the last assistant text. The
 * `response.completed` payload is authoritative; deltas are the fallback.
 */
const readJarvisCodexStream = (response: Response): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: async () => {
      const body = response.body;
      if (body === null) return null;
      let buffer = "";
      let deltas = "";
      let completed: string | null = null;
      let total = 0;
      const decoder = new TextDecoder();
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) return completed ?? (deltas.length > 0 ? deltas : null);
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data.length === 0 || data === "[DONE]") continue;
          let event: unknown;
          try {
            event = decodeUnknownJsonSync(data);
          } catch {
            continue;
          }
          const parsed = interpretJarvisCodexSseEvent(event);
          if (parsed.type === "text") {
            deltas += parsed.delta;
            // Return the moment the JSON object is balanced. The backend's
            // response.completed event can trail the text by seconds, and the
            // supervisor only needs the object.
            if (extractJarvisCodexJsonObject(deltas) !== null) return deltas;
          }
          if (parsed.type === "completed") {
            completed = parsed.text ?? (deltas.length > 0 ? deltas : null);
            return completed;
          }
        }
      }
      return completed ?? (deltas.length > 0 ? deltas : null);
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));

export const JarvisCodexSupervisorLive = makeJarvisCodexSupervisorLive();
