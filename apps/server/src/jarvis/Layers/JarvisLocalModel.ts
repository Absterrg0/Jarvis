import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { adaptExtractionProposal } from "@t3tools/jarvis-core/extraction";
import * as ServerConfig from "../../config.ts";
import {
  JARVIS_LOCAL_MODEL_DEFAULT,
  JarvisLocalModel,
  type JarvisLocalModelConfig,
  type JarvisLocalModelOutcome,
  isLocalModelQualityEligible,
} from "../Services/JarvisLocalModel.ts";

const MAX_SOURCE = 16_000;
const MAX_STDOUT_BYTES = 64_000;
const POLICY_SIDECAR = "policy-thresholds.json";
const EVAL_REPORT = "eval.json";
const INFERENCE_SCRIPT_PARTS = ["scripts", "jarvis-extract", "inference.py"] as const;
/** Levels from `apps/server/src/jarvis/Layers/` up to the repo root. */
const LAYERS_TO_REPO_ROOT = 5;

const decodeUnknownJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export interface RawExtractorJson {
  readonly text?: unknown;
  readonly action?: unknown;
  readonly actionConfidence?: unknown;
  readonly action_confidence?: unknown;
  readonly spans?: unknown;
  readonly overflow?: unknown;
  readonly truncated?: unknown;
}

/**
 * Default inference script for the directory this module lives in. Pure path
 * math, pinned by unit test: `apps/server/src/jarvis/Layers/` is five levels
 * below the repo root, so four would land on the nonexistent
 * `apps/scripts/jarvis-extract/inference.py`.
 */
export const defaultInferenceScriptForDirname = (
  dirname: string,
  resolve: (...parts: Array<string>) => string,
): string =>
  resolve(
    dirname,
    ...Array.from({ length: LAYERS_TO_REPO_ROOT }, () => ".."),
    ...INFERENCE_SCRIPT_PARTS,
  );

/**
 * Strip the child payload down to the adapter's closed keys. The inference
 * script emits diagnostics (raw_action, action_probs, tokens, thresholds)
 * the contract rejects, so only the scored proposal crosses the boundary.
 */
const toAdapterInput = (
  raw: RawExtractorJson,
):
  | {
      readonly text: string;
      readonly action: string;
      readonly spans: unknown;
      readonly overflow?: boolean;
      readonly actionConfidence?: number;
    }
  | undefined => {
  if (typeof raw.text !== "string" || typeof raw.action !== "string") return undefined;
  if (!Array.isArray(raw.spans)) return undefined;
  const overflow =
    raw.overflow === true || raw.truncated === true
      ? true
      : raw.overflow === false || raw.truncated === false
        ? false
        : undefined;
  const confidence =
    typeof raw.actionConfidence === "number"
      ? raw.actionConfidence
      : typeof raw.action_confidence === "number"
        ? raw.action_confidence
        : undefined;
  return {
    text: raw.text,
    action: raw.action,
    spans: raw.spans,
    ...(overflow === undefined ? {} : { overflow }),
    ...(confidence === undefined ? {} : { actionConfidence: confidence }),
  };
};

/**
 * Shared child-output decision: the one place that turns raw inference JSON
 * into a typed tier outcome. Production `infer` and the offline probe both
 * call this, so the probe cannot drift into its own adapter semantics.
 * ORIGINAL source must echo byte-for-byte; clarify/overflow/truncated is
 * language uncertainty (decline to the provider); only the authority
 * rejection (node-routing) refuses without provider fallback.
 */
export const resolveLocalModelOutcome = (
  source: string,
  raw: RawExtractorJson,
): JarvisLocalModelOutcome => {
  if (raw.text !== source) {
    return { status: "decline", reason: "text-mismatch" };
  }
  if (raw.action === "clarify" || raw.overflow === true || raw.truncated === true) {
    return { status: "decline", reason: "local-model-abstained" };
  }
  const adapterInput = toAdapterInput(raw);
  if (adapterInput === undefined) {
    return { status: "decline", reason: "local-model-error" };
  }
  const adapted = adaptExtractionProposal(adapterInput);
  if (adapted.status === "proposal") {
    return { status: "proposal", proposal: adapted.proposal };
  }
  if (adapted.reason === "node-routing") {
    return { status: "rejected", reason: adapted.reason, prompt: adapted.prompt };
  }
  return { status: "decline", reason: "local-model-abstained" };
};

const readConfig = (server: ServerConfig.ServerConfig["Service"]): JarvisLocalModelConfig => {
  const configured = server.jarvisLocalModel;
  if (configured === undefined) return JARVIS_LOCAL_MODEL_DEFAULT;
  return {
    enabled: configured.enabled === true,
    modelDir: configured.modelDir ?? "",
    pythonBin: configured.pythonBin ?? JARVIS_LOCAL_MODEL_DEFAULT.pythonBin,
    timeoutMs: configured.timeoutMs ?? JARVIS_LOCAL_MODEL_DEFAULT.timeoutMs,
    ...(configured.evalReportPath === undefined
      ? {}
      : { evalReportPath: configured.evalReportPath }),
    ...(configured.policyPath === undefined ? {} : { policyPath: configured.policyPath }),
    ...(configured.inferenceScriptPath === undefined
      ? {}
      : { inferenceScriptPath: configured.inferenceScriptPath }),
  };
};

/** Disabled stub: zero workers, never touches the filesystem or a child. */
export const JarvisLocalModelDisabledLive = Layer.succeed(JarvisLocalModel, {
  infer: () => Effect.succeed({ status: "decline", reason: "local-model-disabled" } as const),
});

export const JarvisLocalModelLive = Layer.effect(
  JarvisLocalModel,
  Effect.gen(function* () {
    const server = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const config = readConfig(server);

    const infer = (request: {
      readonly source: string;
    }): Effect.Effect<JarvisLocalModelOutcome> => {
      const source = request.source;
      if (config.enabled !== true || config.modelDir.trim().length === 0) {
        return Effect.succeed({ status: "decline", reason: "local-model-disabled" } as const);
      }
      if (source.length === 0 || source.length > MAX_SOURCE) {
        return Effect.succeed({ status: "decline", reason: "source-too-large" } as const);
      }
      if (!/[\p{Letter}\p{Number}]/u.test(source)) {
        return Effect.succeed({ status: "decline", reason: "source-too-large" } as const);
      }
      return Effect.gen(function* () {
        const policyPath =
          config.policyPath !== undefined && config.policyPath.trim().length > 0
            ? config.policyPath
            : path.join(config.modelDir, POLICY_SIDECAR);
        const reportPath =
          config.evalReportPath !== undefined && config.evalReportPath.trim().length > 0
            ? config.evalReportPath
            : path.join(config.modelDir, EVAL_REPORT);
        const reportRaw = yield* fs
          .readFileString(reportPath)
          .pipe(Effect.orElseSucceed(() => null));
        if (reportRaw === null) {
          yield* Effect.logWarning("ARIS local model report unreadable; declining to provider.", {
            reportPath,
          });
          return { status: "decline", reason: "quality-gate-failed" };
        }
        const report = yield* decodeUnknownJson(reportRaw).pipe(Effect.orElseSucceed(() => null));
        // The report must name the exact artifact and policy under test, so a
        // report cannot gate one candidate while inference runs another.
        if (
          report === null ||
          !isLocalModelQualityEligible(report, {
            modelDir: config.modelDir,
            policyPath,
          })
        ) {
          yield* Effect.logWarning("ARIS local model quality gate failed; declining to provider.", {
            reportPath,
          });
          return { status: "decline", reason: "quality-gate-failed" };
        }

        // The joint policy is required, not optional: inference always runs
        // with the same `--policy` file the gate just bound, so a missing
        // sidecar fails closed here with no spawn instead of falling back
        // to action-only thresholds inside the child.
        const policyExists = yield* fs.exists(policyPath).pipe(Effect.orElseSucceed(() => false));
        if (!policyExists) {
          yield* Effect.logWarning("ARIS local model policy missing; declining to provider.", {
            policyPath,
          });
          return { status: "decline", reason: "quality-gate-failed" };
        }

        const scriptOverride = config.inferenceScriptPath?.trim() ?? "";
        const script =
          scriptOverride.length > 0
            ? scriptOverride
            : defaultInferenceScriptForDirname(import.meta.dirname, (...parts) =>
                path.resolve(...parts),
              );
        // One scoped child per call. The finalizer owns exactly this handle:
        // scope close (completion, timeout, or interruption) terminates only
        // this child. No daemon, no polling, no shared process.
        const collected = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(
                config.pythonBin,
                [
                  script,
                  "--model-dir",
                  config.modelDir,
                  "--int8",
                  "--policy",
                  policyPath,
                  "--text",
                  source,
                ],
                {
                  cwd: config.modelDir,
                  stdin: "ignore",
                  stderr: "ignore",
                },
              ),
            );
            yield* Effect.addFinalizer(() =>
              handle.isRunning.pipe(
                Effect.flatMap((running) => (running ? handle.kill() : Effect.void)),
                Effect.ignore,
              ),
            );
            // Cap stdout while reading: the fold stops at the first chunk
            // past the budget instead of collecting an unbounded string.
            const usedBytes = yield* Ref.make(0);
            const stdout = yield* handle.stdout.pipe(
              Stream.decodeText(),
              Stream.takeWhileEffect((chunk) =>
                Ref.modify(usedBytes, (total) => {
                  const next = total + chunk.length;
                  return [next <= MAX_STDOUT_BYTES, next] as const;
                }),
              ),
              Stream.mkString,
            );
            const exitCode = yield* handle.exitCode;
            const capped = (yield* Ref.get(usedBytes)) > MAX_STDOUT_BYTES;
            return { stdout, exitCode, capped } as const;
          }),
        ).pipe(
          Effect.timeoutOption(Duration.millis(config.timeoutMs)),
          Effect.orElseSucceed(() => "failed" as const),
        );
        if (collected === "failed") {
          yield* Effect.logWarning("ARIS local model failed; declining to provider.");
          return { status: "decline", reason: "local-model-error" };
        }
        if (Option.isNone(collected)) {
          yield* Effect.logWarning("ARIS local model timed out; declining to provider.", {
            timeoutMs: config.timeoutMs,
          });
          return { status: "decline", reason: "local-model-timeout" };
        }
        const { stdout, exitCode, capped } = collected.value;
        if (capped) {
          yield* Effect.logWarning("ARIS local model output too large; declining to provider.");
          return { status: "decline", reason: "local-model-error" };
        }
        if (exitCode !== 0) {
          yield* Effect.logWarning("ARIS local model exited nonzero; declining to provider.", {
            exitCode,
          });
          return { status: "decline", reason: "local-model-error" };
        }
        const parsed = yield* decodeUnknownJson(stdout).pipe(Effect.orElseSucceed(() => null));
        if (parsed === null || typeof parsed !== "object") {
          yield* Effect.logWarning(
            "ARIS local model returned invalid JSON; declining to provider.",
          );
          return { status: "decline", reason: "local-model-error" };
        }
        const raw = parsed as RawExtractorJson;
        const outcome = resolveLocalModelOutcome(source, raw);
        if (outcome.status === "proposal" || outcome.status === "rejected") {
          return outcome;
        }
        if (outcome.reason === "text-mismatch") {
          yield* Effect.logWarning("ARIS local model text mismatch; declining to provider.");
        } else if (outcome.reason === "local-model-abstained") {
          yield* Effect.logWarning("ARIS local model abstained; declining to provider.");
        } else {
          yield* Effect.logWarning(
            "ARIS local model returned malformed spans; declining to provider.",
          );
        }
        return outcome;
      });
    };

    return { infer };
  }),
);
