// @effect-diagnostics nodeBuiltinImport:off - the supervisor owns raw HTTP and needs a hard timeout.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { decodeJarvisSemanticProposal } from "@t3tools/jarvis-core/command";

import { JARVIS_FAST_SUPERVISOR_SYSTEM_PROMPT } from "../Services/JarvisFastSupervisor.ts";
import {
  JARVIS_OPENCODE_SUPERVISOR_MAX_PROMPT_CHARS,
  JARVIS_OPENCODE_SESSION_HEADER,
  JarvisOpencodeSupervisor,
  buildJarvisOpencodeChatBody,
  interpretJarvisOpencodeSseEvent,
  parseJarvisOpencodeAuth,
  resolveJarvisOpencodeRoute,
  type JarvisOpencodeAuth,
  type JarvisOpencodeSupervisorAvailability,
  type JarvisOpencodeSupervisorOutcome,
} from "../Services/JarvisOpencodeSupervisor.ts";
import { extractJarvisCodexJsonObject } from "../Services/JarvisCodexSupervisor.ts";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_RESPONSE_BYTES = 4_000_000;

const decodeUnknownJsonSync = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface ResolvedOpencodeAuth {
  readonly at: number;
  readonly auth: JarvisOpencodeAuth;
}

export interface JarvisOpencodeSupervisorLiveOptions {
  readonly authFiles?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly homeDirectory?: string;
  readonly goModel?: string;
  readonly zenModel?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Direct supervisor over the OpenCode gateway. Disabled behavior is a decline,
 * so a machine without an OpenCode login keeps the provider supervisor with no
 * added latency beyond one cached auth read.
 */
export const makeJarvisOpencodeSupervisorLive = (
  options: JarvisOpencodeSupervisorLiveOptions = {},
): Layer.Layer<JarvisOpencodeSupervisor, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    JarvisOpencodeSupervisor,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const doFetch = options.fetchImpl ?? fetch;
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
      const homeDirectory = options.homeDirectory ?? NodeOS.homedir();

      const authFileCandidates = (): ReadonlyArray<string> => {
        const seen = new Set<string>();
        const ordered: string[] = [];
        const push = (value: string | undefined): void => {
          const trimmed = value?.trim() ?? "";
          if (trimmed.length === 0 || seen.has(trimmed)) return;
          seen.add(trimmed);
          ordered.push(trimmed);
        };
        push(process.env.JARVIS_OPENCODE_AUTH_FILE);
        for (const candidate of options.authFiles ?? []) push(candidate);
        if (homeDirectory.length > 0) {
          push(path.join(homeDirectory, ".local", "share", "opencode", "auth.json"));
        }
        return ordered;
      };

      const cacheRef = yield* Ref.make<ResolvedOpencodeAuth | null>(null);

      const resolve = Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const cached = yield* Ref.get(cacheRef);
        if (cached !== null && nowMs - cached.at < cacheTtlMs) return cached;
        for (const filePath of authFileCandidates()) {
          const text = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
          if (text === null) continue;
          const json = yield* decodeUnknownJson(text).pipe(Effect.orElseSucceed(() => null));
          if (json === null) continue;
          const auth = parseJarvisOpencodeAuth(json);
          const entry: ResolvedOpencodeAuth = { at: nowMs, auth };
          yield* Ref.set(cacheRef, entry);
          return entry;
        }
        const entry: ResolvedOpencodeAuth = { at: nowMs, auth: {} };
        yield* Ref.set(cacheRef, entry);
        return entry;
      });

      const interpret = (input: {
        readonly prompt: string;
        readonly model?: string;
      }): Effect.Effect<JarvisOpencodeSupervisorOutcome> =>
        Effect.gen(function* () {
          const prompt = input.prompt;
          if (
            prompt.trim().length === 0 ||
            prompt.length > JARVIS_OPENCODE_SUPERVISOR_MAX_PROMPT_CHARS
          ) {
            return { status: "decline", reason: "opencode-supervisor-error" } as const;
          }
          const resolved = yield* resolve;
          const route = resolveJarvisOpencodeRoute({
            auth: resolved.auth,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(options.goModel === undefined ? {} : { goModel: options.goModel }),
            ...(options.zenModel === undefined ? {} : { zenModel: options.zenModel }),
          });
          if (route === null) {
            return { status: "decline", reason: "opencode-supervisor-unauthenticated" } as const;
          }
          const body = buildJarvisOpencodeChatBody({
            model: route.model,
            prompt,
            instructions: JARVIS_FAST_SUPERVISOR_SYSTEM_PROMPT,
          });
          const response = yield* Effect.tryPromise({
            try: () =>
              doFetch(`${route.baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${route.key}`,
                  "content-type": "application/json",
                  accept: "text/event-stream",
                  [JARVIS_OPENCODE_SESSION_HEADER]: NodeCrypto.randomUUID(),
                },
                body: encodeUnknownJson(body),
                signal: AbortSignal.timeout(timeoutMs),
              }),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          if (response === null) {
            yield* Effect.logWarning(
              "ARIS opencode supervisor request failed or timed out; falling back.",
            );
            return { status: "decline", reason: "opencode-supervisor-timeout" } as const;
          }
          if (!response.ok) {
            const detail = yield* Effect.tryPromise({
              try: () => response.text(),
              catch: () => null,
            }).pipe(Effect.orElseSucceed(() => null));
            yield* Effect.logDebug(
              `ARIS opencode supervisor HTTP ${response.status}: ${(detail ?? "").slice(0, 200)}`,
            );
            return { status: "decline", reason: "opencode-supervisor-error" } as const;
          }
          const streamed = yield* readJarvisOpencodeStream(response);
          if (streamed === null) {
            return { status: "decline", reason: "opencode-supervisor-malformed" } as const;
          }
          const raw = extractJarvisCodexJsonObject(streamed);
          if (raw === null) {
            return { status: "decline", reason: "opencode-supervisor-malformed" } as const;
          }
          const proposal = yield* Effect.try({
            try: () => decodeJarvisSemanticProposal(raw),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          if (proposal === null) {
            return { status: "decline", reason: "opencode-supervisor-malformed" } as const;
          }
          return { status: "proposal", proposal } as const;
        });

      return {
        availability: resolve.pipe(
          Effect.map((resolved): JarvisOpencodeSupervisorAvailability => {
            const route = resolveJarvisOpencodeRoute({
              auth: resolved.auth,
              ...(options.goModel === undefined ? {} : { goModel: options.goModel }),
              ...(options.zenModel === undefined ? {} : { zenModel: options.zenModel }),
            });
            return route === null
              ? { available: false }
              : { available: true, route: route.route, model: route.model };
          }),
        ),
        interpret,
      };
    }),
  );

/** Read the chat-completions stream, returning as soon as the JSON is balanced. */
const readJarvisOpencodeStream = (response: Response): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: async () => {
      const body = response.body;
      if (body === null) return null;
      let buffer = "";
      let text = "";
      let total = 0;
      let done = false;
      const decoder = new TextDecoder();
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) return text.length > 0 ? text : null;
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            done = true;
            break;
          }
          if (data.length === 0) continue;
          let event: unknown;
          try {
            event = decodeUnknownJsonSync(data);
          } catch {
            continue;
          }
          const parsed = interpretJarvisOpencodeSseEvent(event);
          if (parsed.type === "text") {
            text += parsed.delta;
            if (extractJarvisCodexJsonObject(text) !== null) return text;
          }
        }
        if (done) break;
      }
      buffer += decoder.decode();
      const trailing = buffer.trim();
      if (!done && trailing.startsWith("data:")) {
        const data = trailing.slice(5).trim();
        if (data.length > 0 && data !== "[DONE]") {
          try {
            const event = decodeUnknownJsonSync(data);
            const parsed = interpretJarvisOpencodeSseEvent(event);
            if (parsed.type === "text") {
              text += parsed.delta;
            }
          } catch {
            // Ignore a malformed trailing line, matching in-loop behavior.
          }
        }
      }
      return text.length > 0 ? text : null;
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));

export const JarvisOpencodeSupervisorLive = makeJarvisOpencodeSupervisorLive();
