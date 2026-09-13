// @effect-diagnostics nodeBuiltinImport:off - the supervisor owns raw HTTP and needs a hard timeout.
import * as NodeOS from "node:os";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { decodeCirceSemanticProposal } from "@circe/core/command";

import {
  CIRCE_CODEX_SUPERVISOR_MAX_PROMPT_CHARS,
  extractCirceCodexJsonObject,
  interpretCirceCodexSseEvent,
} from "../Services/CirceCodexSupervisor.ts";
import { CIRCE_FAST_SUPERVISOR_SYSTEM_PROMPT } from "../Services/CirceFastSupervisor.ts";
import {
  CIRCE_GROK_CLIENT_IDENTIFIER,
  CIRCE_GROK_DEFAULT_CLIENT_VERSION,
  CIRCE_GROK_OAUTH_CLIENT_ID,
  CIRCE_GROK_RESPONSES_ENDPOINT,
  CIRCE_GROK_SUPERVISOR_DEFAULT_MODEL,
  CIRCE_GROK_TOKEN_ENDPOINT,
  CirceGrokSupervisor,
  buildCirceGrokResponsesBody,
  isGrokCredentialFresh,
  mergeCirceGrokRefreshedAuth,
  parseCirceGrokAuth,
  type CirceGrokCredentials,
  type CirceGrokSupervisorAvailability,
  type CirceGrokSupervisorOutcome,
  type ParsedCirceGrokAuth,
} from "../Services/CirceGrokSupervisor.ts";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_REFRESH_SKEW_MS = 60_000;
const MAX_RESPONSE_BYTES = 4_000_000;

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonSync = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface ResolvedGrokAuth {
  readonly at: number;
  readonly filePath: string | null;
  readonly credentials: CirceGrokCredentials | null;
  readonly clientVersion: string;
}

export interface CirceGrokSupervisorLiveOptions {
  readonly authFiles?: ReadonlyArray<string>;
  readonly versionFiles?: ReadonlyArray<string>;
  readonly endpoint?: string;
  readonly tokenEndpoint?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly refreshSkewMs?: number;
  readonly homeDirectory?: string;
  readonly fetchImpl?: typeof fetch;
}

export const makeCirceGrokSupervisorLive = (
  options: CirceGrokSupervisorLiveOptions = {},
): Layer.Layer<CirceGrokSupervisor, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    CirceGrokSupervisor,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const doFetch = options.fetchImpl ?? fetch;
      const endpoint = options.endpoint ?? CIRCE_GROK_RESPONSES_ENDPOINT;
      const tokenEndpoint = options.tokenEndpoint ?? CIRCE_GROK_TOKEN_ENDPOINT;
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
      const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
      const homeDirectory = options.homeDirectory ?? NodeOS.homedir();
      const model =
        options.model?.trim() ||
        process.env.CIRCE_GROK_SUPERVISOR_MODEL?.trim() ||
        CIRCE_GROK_SUPERVISOR_DEFAULT_MODEL;

      const candidates = (
        explicit: ReadonlyArray<string> | undefined,
        env: string | undefined,
        homeFallbacks: ReadonlyArray<string>,
      ): ReadonlyArray<string> => {
        const seen = new Set<string>();
        const ordered: string[] = [];
        const push = (value: string | undefined): void => {
          const trimmed = value?.trim() ?? "";
          if (trimmed.length === 0 || seen.has(trimmed)) return;
          seen.add(trimmed);
          ordered.push(trimmed);
        };
        push(env);
        for (const candidate of explicit ?? []) push(candidate);
        if (homeDirectory.length > 0) for (const candidate of homeFallbacks) push(candidate);
        return ordered;
      };

      const authFiles = candidates(options.authFiles, process.env.CIRCE_GROK_AUTH_FILE, [
        path.join(homeDirectory, ".grok", "auth.json"),
        path.join(homeDirectory, ".fx", "grok-auth.json"),
      ]);
      const versionFiles = candidates(options.versionFiles, undefined, [
        path.join(homeDirectory, ".grok", "version.json"),
        path.join(homeDirectory, ".fx", "provider-versions", "grok.json"),
      ]);

      const readJson = (filePath: string) =>
        fs.readFileString(filePath).pipe(
          Effect.flatMap((text) => decodeUnknownJson(text).pipe(Effect.orElseSucceed(() => null))),
          Effect.orElseSucceed(() => null),
        );

      const resolveClientVersion = Effect.gen(function* () {
        for (const filePath of versionFiles) {
          const json = yield* readJson(filePath);
          if (json === null || typeof json !== "object") continue;
          const version = (json as Record<string, unknown>)["version"];
          if (typeof version === "string" && version.trim().length > 0) return version.trim();
        }
        return CIRCE_GROK_DEFAULT_CLIENT_VERSION;
      });

      const refreshCredentials = (
        filePath: string,
        parsed: ParsedCirceGrokAuth,
        original: unknown,
      ): Effect.Effect<CirceGrokCredentials | null> =>
        Effect.gen(function* () {
          const refreshToken = parsed.credentials.refreshToken;
          if (refreshToken === undefined) return null;
          const body = new URLSearchParams({
            client_id: CIRCE_GROK_OAUTH_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
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
          const expiresIn =
            typeof record["expires_in"] === "number" && Number.isFinite(record["expires_in"])
              ? record["expires_in"]
              : undefined;
          const nowDateTime = yield* DateTime.now;
          const nowMs = DateTime.toEpochMillis(nowDateTime);
          const expiresAtMs = expiresIn === undefined ? undefined : nowMs + expiresIn * 1000;
          yield* fs
            .writeFileString(
              filePath,
              `${encodeUnknownJson(
                mergeCirceGrokRefreshedAuth({
                  shape: parsed.shape,
                  original,
                  accessToken,
                  ...(refreshTokenNext === undefined ? {} : { refreshToken: refreshTokenNext }),
                  ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
                  ...(expiresAtMs === undefined
                    ? {}
                    : { expiresAtIso: DateTime.formatIso(nowDateTime) }),
                  ...(parsed.shape === "grok-cli" ? { key: parsed.key } : {}),
                }),
              )}\n`,
            )
            .pipe(Effect.orElseSucceed(() => undefined));
          return {
            accessToken,
            refreshToken: refreshTokenNext ?? refreshToken,
            ...(parsed.credentials.accountId === undefined
              ? {}
              : { accountId: parsed.credentials.accountId }),
            ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
          } satisfies CirceGrokCredentials;
        });

      const cacheRef = yield* Ref.make<ResolvedGrokAuth | null>(null);

      const resolve = Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const cached = yield* Ref.get(cacheRef);
        if (cached !== null && nowMs - cached.at < cacheTtlMs) return cached;
        const clientVersion = yield* resolveClientVersion;
        for (const filePath of authFiles) {
          const text = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
          if (text === null) continue;
          const json = yield* decodeUnknownJson(text).pipe(Effect.orElseSucceed(() => null));
          if (json === null) continue;
          const parsed = parseCirceGrokAuth(json);
          if (parsed === null) continue;
          let credentials = parsed.credentials;
          if (!isGrokCredentialFresh(credentials, nowMs, refreshSkewMs)) {
            const refreshed = yield* refreshCredentials(filePath, parsed, json);
            if (refreshed !== null) credentials = refreshed;
          }
          const entry: ResolvedGrokAuth = { at: nowMs, filePath, credentials, clientVersion };
          yield* Ref.set(cacheRef, entry);
          return entry;
        }
        const entry: ResolvedGrokAuth = {
          at: nowMs,
          filePath: null,
          credentials: null,
          clientVersion,
        };
        yield* Ref.set(cacheRef, entry);
        return entry;
      });

      const interpret = (input: {
        readonly prompt: string;
        readonly model?: string;
      }): Effect.Effect<CirceGrokSupervisorOutcome> =>
        Effect.gen(function* () {
          const prompt = input.prompt;
          if (
            prompt.trim().length === 0 ||
            prompt.length > CIRCE_CODEX_SUPERVISOR_MAX_PROMPT_CHARS
          ) {
            return { status: "decline", reason: "grok-supervisor-error" } as const;
          }
          const resolved = yield* resolve;
          const credentials = resolved.credentials;
          if (credentials === null) {
            return { status: "decline", reason: "grok-supervisor-unauthenticated" } as const;
          }
          const selectedModel = input.model?.trim() || model;
          const response = yield* Effect.tryPromise({
            try: () =>
              doFetch(endpoint, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${credentials.accessToken}`,
                  accept: "text/event-stream",
                  "content-type": "application/json",
                  "X-XAI-Token-Auth": "xai-grok-cli",
                  "x-authenticateresponse": "authenticate-response",
                  "x-grok-client-identifier": CIRCE_GROK_CLIENT_IDENTIFIER,
                  "x-grok-client-version": resolved.clientVersion,
                  "x-grok-model-override": selectedModel,
                  ...(credentials.accountId === undefined
                    ? {}
                    : { "x-grok-user-id": credentials.accountId }),
                },
                body: encodeUnknownJson(
                  buildCirceGrokResponsesBody({
                    model: selectedModel,
                    prompt,
                    instructions: CIRCE_FAST_SUPERVISOR_SYSTEM_PROMPT,
                  }),
                ),
                signal: AbortSignal.timeout(timeoutMs),
              }),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          if (response === null) {
            yield* Effect.logWarning(
              "Circe grok supervisor request failed or timed out; falling back.",
            );
            return { status: "decline", reason: "grok-supervisor-timeout" } as const;
          }
          if (!response.ok) {
            const detail = yield* Effect.tryPromise({
              try: () => response.text(),
              catch: () => null,
            }).pipe(Effect.orElseSucceed(() => null));
            yield* Effect.logWarning(
              `Circe grok supervisor HTTP ${response.status}: ${(detail ?? "").slice(0, 160)}`,
            );
            return { status: "decline", reason: "grok-supervisor-error" } as const;
          }
          const streamed = yield* readCirceGrokStream(response);
          if (streamed === null) {
            return { status: "decline", reason: "grok-supervisor-malformed" } as const;
          }
          const raw = extractCirceCodexJsonObject(streamed);
          if (raw === null) {
            return { status: "decline", reason: "grok-supervisor-malformed" } as const;
          }
          const proposal = yield* Effect.try({
            try: () => decodeCirceSemanticProposal(raw),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          if (proposal === null) {
            return { status: "decline", reason: "grok-supervisor-malformed" } as const;
          }
          return { status: "proposal", proposal } as const;
        });

      return {
        availability: resolve.pipe(
          Effect.map((resolved): CirceGrokSupervisorAvailability =>
            resolved.credentials === null ? { available: false } : { available: true, model },
          ),
        ),
        interpret,
      };
    }),
  );

const readCirceGrokStream = (response: Response): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: async () => {
      const body = response.body;
      if (body === null) return null;
      let buffer = "";
      let deltas = "";
      let total = 0;
      const decoder = new TextDecoder();
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) break;
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
          const parsed = interpretCirceCodexSseEvent(event);
          if (parsed.type === "text") {
            deltas += parsed.delta;
            if (extractCirceCodexJsonObject(deltas) !== null) return deltas;
          }
          if (parsed.type === "completed") {
            return parsed.text ?? (deltas.length > 0 ? deltas : null);
          }
        }
      }
      return deltas.length > 0 ? deltas : null;
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));

export const CirceGrokSupervisorLive = makeCirceGrokSupervisorLive();
