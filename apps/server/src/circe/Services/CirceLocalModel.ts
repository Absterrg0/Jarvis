import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CirceSemanticProposal } from "@circe/core/command";
import type { ExtractionAdapterRejectionReason } from "@circe/core/extraction";

/**
 * Runtime config for the on-demand local extraction tier.
 *
 * Disabled by default: `enabled` false means zero workers, no model load,
 * no spawn. Production enables it only with an explicit model directory and
 * python binary plus a passing quality report (see
 * `isLocalModelQualityEligible`). Weights live outside Git and are never
 * referenced by default.
 */
export interface CirceLocalModelConfig {
  readonly enabled: boolean;
  readonly modelDir: string;
  readonly pythonBin: string;
  readonly timeoutMs: number;
  /** Optional override for the evaluate.py report; defaults to `<modelDir>/eval.json`. */
  readonly evalReportPath?: string | undefined;
  /**
   * Optional override for the calibrated policy sidecar. Defaults to
   * `<modelDir>/policy-thresholds.json`. Always passed as inference
   * `--policy`: the tier never runs on the action-only `thresholds.json`
   * defaults, so a calibrated report cannot gate one policy while inference
   * runs another.
   */
  readonly policyPath?: string | undefined;
  /** Optional override for the inference script; defaults to the repo script. */
  readonly inferenceScriptPath?: string | undefined;
}

export const CIRCE_LOCAL_MODEL_DEFAULT: CirceLocalModelConfig = {
  enabled: false,
  modelDir: "",
  pythonBin: "python3",
  timeoutMs: 8_000,
};

export type CirceLocalModelDeclineReason =
  | "local-model-disabled"
  | "quality-gate-failed"
  | "local-model-unavailable"
  | "local-model-timeout"
  | "local-model-error"
  | "local-model-abstained"
  | "text-mismatch"
  | "source-too-large";

export type CirceLocalModelOutcome =
  | { readonly status: "proposal"; readonly proposal: CirceSemanticProposal }
  | { readonly status: "decline"; readonly reason: CirceLocalModelDeclineReason }
  | {
      readonly status: "rejected";
      readonly reason: ExtractionAdapterRejectionReason;
      readonly prompt: string;
    };

/**
 * On-demand local extraction. One `infer` call may spawn one child process;
 * there is no daemon, polling, or residency. The call takes the ORIGINAL
 * immutable source and returns a host-validatable proposal, a decline (caller
 * falls back to the one provider call), or a rejection (caller answers
 * needs-input with no provider fallback). It never authorizes IDs, rewrites
 * instructions, or answers approvals; the shared Director owns those.
 */
export class CirceLocalModel extends Context.Service<
  CirceLocalModel,
  {
    readonly infer: (input: { readonly source: string }) => Effect.Effect<CirceLocalModelOutcome>;
  }
>()("t3/circe/Services/CirceLocalModel") {}

/** Frozen deployment gate, mirrored from scripts/circe-extract/evaluate.py. */
export const CIRCE_LOCAL_MODEL_QUALITY_THRESHOLDS = {
  minRawActionAcc: 0.95,
  minCompleteFrameAcc: 0.9,
  minUsefulAuto: 0.8,
  maxWrongAuto: 0.01,
  maxAcceptedError: 0.01,
  maxInt8Drop: 0.02,
  maxClarifyRate: 0.95,
} as const;

interface QualityTestMetrics {
  readonly raw_action_acc?: unknown;
  readonly complete_frame_acc?: unknown;
  readonly whole_correct?: unknown;
  readonly useful_auto?: unknown;
  readonly wrong_auto?: unknown;
  readonly accepted_error?: unknown;
  readonly raw_bounds_bad?: unknown;
  readonly clarify_rate?: unknown;
  readonly wrong_auto_host?: unknown;
  readonly truncated?: unknown;
  readonly n?: unknown;
}

/**
 * Deployment binding: the exact artifact and policy the report evaluated.
 * The layer passes the model directory it will infer with and the policy
 * path it will pass as `--policy`, so a report cannot gate one candidate
 * while inference runs another. No hashes or receipts; plain measured-input
 * identity, fail closed on any mismatch.
 */
export interface LocalModelDeploymentBinding {
  readonly modelDir: string;
  readonly policyPath: string;
}

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

const normalizeBindingPath = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.replace(/[/\\]+$/u, "");
};

const readPairedTests = (
  report: unknown,
): { readonly fp32: QualityTestMetrics; readonly int8: QualityTestMetrics } | undefined => {
  if (typeof report !== "object" || report === null) return undefined;
  const root = report as Record<string, unknown>;
  const fp32Node = root.fp32;
  const int8Node = root.int8;
  if (typeof fp32Node !== "object" || fp32Node === null) return undefined;
  if (typeof int8Node !== "object" || int8Node === null) return undefined;
  const fp32Test = (fp32Node as Record<string, unknown>).test;
  const int8Test = (int8Node as Record<string, unknown>).test;
  if (typeof fp32Test !== "object" || fp32Test === null) return undefined;
  if (typeof int8Test !== "object" || int8Test === null) return undefined;
  const fp32 = fp32Test as QualityTestMetrics;
  const int8 = int8Test as QualityTestMetrics;
  if (typeof fp32.raw_action_acc !== "number") return undefined;
  if (typeof int8.raw_action_acc !== "number") return undefined;
  return { fp32, int8 };
};

const metricsPass = (metrics: QualityTestMetrics): boolean => {
  const t = CIRCE_LOCAL_MODEL_QUALITY_THRESHOLDS;
  const raw = asNumber(metrics.raw_action_acc);
  const frame = asNumber(metrics.complete_frame_acc) ?? asNumber(metrics.whole_correct);
  const useful = asNumber(metrics.useful_auto);
  const wrong = asNumber(metrics.wrong_auto);
  const bounds = asInt(metrics.raw_bounds_bad);
  const clarify = asNumber(metrics.clarify_rate);
  if (
    raw === undefined ||
    frame === undefined ||
    useful === undefined ||
    wrong === undefined ||
    bounds === undefined ||
    clarify === undefined
  ) {
    return false;
  }
  if (raw < t.minRawActionAcc) return false;
  if (frame < t.minCompleteFrameAcc) return false;
  if (useful < t.minUsefulAuto) return false;
  if (wrong > t.maxWrongAuto) return false;
  if (bounds !== 0) return false;
  if (clarify >= t.maxClarifyRate) return false;
  const acceptedError = asNumber(metrics.accepted_error);
  if (acceptedError !== undefined && acceptedError > t.maxAcceptedError) return false;
  // Corruption / cross-node host errors must be zero when reported. Missing
  // host fields fail closed: an unevaluated artifact is not eligible.
  const host = metrics.wrong_auto_host;
  if (host === undefined) return false;
  if (asInt(host) !== 0) return false;
  const truncated = metrics.truncated;
  if (truncated === undefined) return false;
  if (asInt(truncated) !== 0) return false;
  return true;
};

/**
 * Deployment eligibility from an evaluate.py report. Checks the frozen
 * user gate on the held-out TEST split for the INT8 runtime precision
 * (raw >= .95, frame >= .90, useful >= .80, wrong <= .01, bounds 0,
 * host 0, truncated 0, no clarify collapse, int8 drop <= .02). Calibration
 * `valid` and `readiness` are never consulted: valid thresholds are not
 * readiness. An arbitrary file presence never passes; only measured metrics
 * pass. Unknown shapes fail closed.
 *
 * When a binding is given, the report must also name the exact artifact it
 * evaluated: top-level `model_dir` must match the deployment model directory
 * and top-level `policy` must match the `--policy` path the deployment will
 * use (precision binds through the int8 section plus the `--int8` flag).
 * Reports without `model_dir` fail closed, so nothing evaluated before the
 * metadata change can activate.
 */
export function isLocalModelQualityEligible(
  report: unknown,
  binding?: LocalModelDeploymentBinding,
): boolean {
  const paired = readPairedTests(report);
  if (paired === undefined) return false;
  if (binding !== undefined) {
    if (typeof report !== "object" || report === null) return false;
    const root = report as Record<string, unknown>;
    if (normalizeBindingPath(root.model_dir) !== normalizeBindingPath(binding.modelDir)) {
      return false;
    }
    if (normalizeBindingPath(root.policy) !== normalizeBindingPath(binding.policyPath)) {
      return false;
    }
  }
  const t = CIRCE_LOCAL_MODEL_QUALITY_THRESHOLDS;
  if (!metricsPass(paired.fp32)) return false;
  if (!metricsPass(paired.int8)) return false;
  const rawFp32 = asNumber(paired.fp32.raw_action_acc) ?? 0;
  const rawInt8 = asNumber(paired.int8.raw_action_acc) ?? 0;
  const frameFp32 =
    asNumber(paired.fp32.complete_frame_acc) ?? asNumber(paired.fp32.whole_correct) ?? 0;
  const frameInt8 =
    asNumber(paired.int8.complete_frame_acc) ?? asNumber(paired.int8.whole_correct) ?? 0;
  const usefulFp32 = asNumber(paired.fp32.useful_auto) ?? 0;
  const usefulInt8 = asNumber(paired.int8.useful_auto) ?? 0;
  if (rawFp32 - rawInt8 > t.maxInt8Drop) return false;
  if (frameFp32 - frameInt8 > t.maxInt8Drop) return false;
  if (usefulFp32 - usefulInt8 > t.maxInt8Drop) return false;
  return true;
}
