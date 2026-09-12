// @effect-diagnostics nodeBuiltinImport:off - a neutral cwd keeps fx from loading repo agent context.
// @effect-diagnostics globalTimers:off - the supervisor owns a raw child process and needs a hard kill on timeout.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { decodeJarvisSemanticProposal } from "@t3tools/jarvis-core/command";

import {
  JARVIS_FAST_SUPERVISOR_MAX_PROMPT_CHARS,
  JARVIS_FAST_SUPERVISOR_SYSTEM_PROMPT,
  JarvisFastSupervisor,
  extractJsonObjectFromText,
  fxAssistantTextFromEnvelope,
  isFxStatusAuthenticated,
  parseFxStatusOutput,
  type JarvisFastSupervisorAvailability,
  type JarvisFastSupervisorOutcome,
} from "../Services/JarvisFastSupervisor.ts";

const MAX_STDOUT_BYTES = 64_000;
const DEFAULT_STATUS_TIMEOUT_MS = 2_000;
// fx's harness adds ~7k tokens and its Codex models reason, so a real proposal
// lands in 7-12s. Too tight a cap only falls back to the slower provider
// harness; this still bounds a hung fx well under the old provider timeout.
const DEFAULT_ASK_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const SUPERVISOR_WORKSPACE_DIR = "jarvis-fx-supervisor";

const decodeUnknownJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

interface ResolvedFx {
  readonly at: number;
  readonly binary: string | null;
  readonly availability: JarvisFastSupervisorAvailability;
}

interface CommandResult {
  readonly stdout: string;
  readonly exitCode: number;
  readonly capped: boolean;
}

export interface JarvisFastSupervisorLiveOptions {
  /** Explicit binary path; `JARVIS_FX_BINARY` and `~/.fx/bin/fx` still rank first. */
  readonly binaryPath?: string;
  readonly statusTimeoutMs?: number;
  readonly askTimeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly homeDirectory?: string;
  readonly workingDirectory?: string;
}

/**
 * Fast supervisor over `fx ask`. Disabled behavior is a decline, so a machine
 * without fx (or without `fx login`) keeps the existing provider supervisor
 * with zero added latency beyond one cached status probe.
 */
export const makeJarvisFastSupervisorLive = (
  options: JarvisFastSupervisorLiveOptions = {},
): Layer.Layer<JarvisFastSupervisor, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    JarvisFastSupervisor,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
      const askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
      const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
      const homeDirectory = options.homeDirectory ?? NodeOS.homedir();
      const workingDirectory =
        options.workingDirectory ?? path.join(NodeOS.tmpdir(), SUPERVISOR_WORKSPACE_DIR);

      const runCommand = (
        command: string,
        args: ReadonlyArray<string>,
        timeoutMs: number,
        env?: Readonly<Record<string, string>>,
      ): Effect.Effect<CommandResult | null> =>
        Effect.tryPromise({
          try: () =>
            new Promise<CommandResult | null>((resolve) => {
              let settled = false;
              let stdout = "";
              let capped = false;
              const child = NodeChildProcess.spawn(command, [...args], {
                cwd: workingDirectory,
                stdio: ["ignore", "pipe", "ignore"],
                ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
              });
              const finish = (value: CommandResult | null): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
              };
              const timer = setTimeout(() => {
                child.kill("SIGKILL");
                finish(null);
              }, timeoutMs);
              child.on("error", () => finish(null));
              child.stdout.setEncoding("utf8");
              child.stdout.on("data", (chunk: string) => {
                if (capped) return;
                stdout += chunk;
                if (stdout.length > MAX_STDOUT_BYTES) {
                  capped = true;
                  child.kill("SIGKILL");
                  finish(null);
                }
              });
              child.on("close", (code) => {
                finish({ stdout, exitCode: code ?? -1, capped });
              });
            }),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));

      const candidates = (): ReadonlyArray<string> => {
        const seen = new Set<string>();
        const ordered: string[] = [];
        const push = (value: string | undefined): void => {
          const trimmed = value?.trim() ?? "";
          if (trimmed.length === 0 || seen.has(trimmed)) return;
          seen.add(trimmed);
          ordered.push(trimmed);
        };
        push(process.env.JARVIS_FX_BINARY);
        push(options.binaryPath);
        push(homeDirectory.length > 0 ? path.join(homeDirectory, ".fx", "bin", "fx") : undefined);
        push("fx");
        return ordered;
      };

      const cacheRef = yield* Ref.make<ResolvedFx | null>(null);

      const resolve = Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const cached = yield* Ref.get(cacheRef);
        if (cached !== null && now - cached.at < cacheTtlMs) return cached;
        for (const candidate of candidates()) {
          const isPath = candidate.includes("/");
          if (isPath) {
            const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
            if (!exists) continue;
          }
          const collected = yield* runCommand(candidate, ["status"], statusTimeoutMs);
          if (collected === null) continue;
          const summary = parseFxStatusOutput(collected.stdout);
          const availability: JarvisFastSupervisorAvailability = isFxStatusAuthenticated(summary)
            ? { available: true, ...(summary.model === null ? {} : { model: summary.model }) }
            : { available: false, ...(summary.model === null ? {} : { model: summary.model }) };
          const entry: ResolvedFx = { at: now, binary: candidate, availability };
          yield* Ref.set(cacheRef, entry);
          return entry;
        }
        const entry: ResolvedFx = { at: now, binary: null, availability: { available: false } };
        yield* Ref.set(cacheRef, entry);
        return entry;
      });

      const interpret = (input: {
        readonly prompt: string;
        readonly model?: string;
      }): Effect.Effect<JarvisFastSupervisorOutcome> =>
        Effect.gen(function* () {
          const prompt = input.prompt;
          if (
            prompt.trim().length === 0 ||
            prompt.length > JARVIS_FAST_SUPERVISOR_MAX_PROMPT_CHARS
          ) {
            return { status: "decline", reason: "fast-supervisor-error" } as const;
          }
          yield* fs
            .makeDirectory(workingDirectory, { recursive: true })
            .pipe(Effect.orElseSucceed(() => undefined));
          const resolved = yield* resolve;
          if (resolved.binary === null || !resolved.availability.available) {
            return { status: "decline", reason: "fast-supervisor-unavailable" } as const;
          }
          const collected = yield* runCommand(
            resolved.binary,
            [
              "ask",
              "--json",
              "--no-save",
              "--no-color",
              "--system",
              JARVIS_FAST_SUPERVISOR_SYSTEM_PROMPT,
              "--",
              prompt,
            ],
            askTimeoutMs,
            {
              ...(input.model === undefined || input.model.trim().length === 0
                ? {}
                : { FX_MODEL: input.model.trim() }),
              FX_MAX_AGENT_STEPS: "1",
            },
          );
          if (collected === null) {
            yield* Effect.logDebug("ARIS fast supervisor timed out; falling back to providers.");
            return { status: "decline", reason: "fast-supervisor-timeout" } as const;
          }
          if (collected.capped || collected.exitCode !== 0) {
            yield* Effect.logDebug("ARIS fast supervisor failed; falling back to providers.", {
              exitCode: collected.exitCode,
              capped: collected.capped,
            });
            return { status: "decline", reason: "fast-supervisor-error" } as const;
          }
          const envelope = yield* decodeUnknownJson(collected.stdout).pipe(
            Effect.orElseSucceed(() => null),
          );
          const assistantText = fxAssistantTextFromEnvelope(envelope);
          if (assistantText === null) {
            yield* Effect.logDebug("ARIS fast supervisor returned no assistant text.");
            return { status: "decline", reason: "fast-supervisor-malformed" } as const;
          }
          const raw = extractJsonObjectFromText(assistantText);
          if (raw === null) {
            yield* Effect.logDebug("ARIS fast supervisor returned no JSON object.");
            return { status: "decline", reason: "fast-supervisor-malformed" } as const;
          }
          const proposal = yield* Effect.try({
            try: () => decodeJarvisSemanticProposal(raw),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          if (proposal === null) {
            yield* Effect.logDebug("ARIS fast supervisor returned an invalid proposal schema.");
            return { status: "decline", reason: "fast-supervisor-malformed" } as const;
          }
          return { status: "proposal", proposal } as const;
        });

      return {
        availability: resolve.pipe(Effect.map((resolved) => resolved.availability)),
        interpret,
      };
    }),
  );

export const JarvisFastSupervisorLive = makeJarvisFastSupervisorLive();
