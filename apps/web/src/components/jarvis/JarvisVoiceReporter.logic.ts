import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type DesktopJarvisVoiceState,
  type EnvironmentId,
  type JarvisVoiceReport,
} from "@t3tools/contracts";
import type { JarvisVoiceReportBatch } from "@t3tools/contracts";

export function isJarvisVoiceReadyEdge(
  previousStatus: DesktopJarvisVoiceState["status"] | undefined,
  nextStatus: DesktopJarvisVoiceState["status"],
): boolean {
  return nextStatus === "ready" && previousStatus !== "ready";
}

export function removedJarvisReportIds(
  previous: ReadonlyMap<string, unknown>,
  next: ReadonlyMap<string, unknown>,
): readonly string[] {
  return [...previous.keys()].filter((reportId) => !next.has(reportId));
}

export function foldJarvisVoiceReportBatch(
  previous: ReadonlyMap<string, JarvisVoiceReport>,
  batch: JarvisVoiceReportBatch,
): Map<string, JarvisVoiceReport> {
  const next =
    batch.removedReportIds === undefined ? new Map<string, JarvisVoiceReport>() : new Map(previous);
  for (const delivery of batch.deliveries) next.set(delivery.report.reportId, delivery.report);
  for (const reportId of batch.removedReportIds ?? []) next.delete(reportId);
  return next;
}

const terminalReportKinds = new Set<JarvisVoiceReport["kind"]>([
  "completed",
  "waiting-for-input",
  "approval-needed",
  "failed",
]);

function reportTaskKey(environmentId: EnvironmentId, report: JarvisVoiceReport): string {
  return report.taskRef === undefined
    ? `${environmentId}:${report.threadId}`
    : `${report.taskRef.executionNodeId}:${report.taskRef.remoteThreadId ?? report.taskRef.remoteTaskId}`;
}

function reportCorrelationKey(environmentId: EnvironmentId, report: JarvisVoiceReport): string {
  return `${reportTaskKey(environmentId, report)}:${report.turnId ?? ""}`;
}

export function effectiveJarvisVoiceReportBatch(
  previous: ReadonlyMap<string, JarvisVoiceReport>,
  input: {
    readonly batch: JarvisVoiceReportBatch;
    readonly environmentId: EnvironmentId;
  },
): JarvisVoiceReportBatch {
  const terminalKeys = new Set(
    input.batch.deliveries
      .filter(({ report }) => terminalReportKinds.has(report.kind))
      .map(({ report }) => reportCorrelationKey(input.environmentId, report)),
  );
  if (terminalKeys.size === 0) return input.batch;

  const supersededReportIds = new Set<string>();
  for (const report of previous.values()) {
    if (
      report.kind === "work-started" &&
      terminalKeys.has(reportCorrelationKey(input.environmentId, report))
    ) {
      supersededReportIds.add(report.reportId);
    }
  }
  const deliveries = input.batch.deliveries.filter(({ report }) => {
    if (report.kind !== "work-started") return true;
    const superseded = terminalKeys.has(reportCorrelationKey(input.environmentId, report));
    if (superseded) supersededReportIds.add(report.reportId);
    return !superseded;
  });
  if (supersededReportIds.size === 0) return input.batch;
  return {
    ...input.batch,
    deliveries,
    removedReportIds: [
      ...new Set([...(input.batch.removedReportIds ?? []), ...supersededReportIds]),
    ],
  };
}

export function foldJarvisVoiceReportBatchWithPresentation(
  previous: ReadonlyMap<string, JarvisVoiceReport>,
  batch: JarvisVoiceReportBatch,
): {
  readonly reports: Map<string, JarvisVoiceReport>;
  readonly deliveries: readonly JarvisVoiceReportBatch["deliveries"][number][];
  readonly removedReportIds: readonly string[];
} {
  const removed = new Set(batch.removedReportIds ?? []);
  const reports = foldJarvisVoiceReportBatch(previous, batch);
  return {
    reports,
    deliveries: batch.deliveries.filter(({ report }) => !removed.has(report.reportId)),
    removedReportIds: [...removed],
  };
}

export function foldJarvisVoicePresentation(
  previous: ReadonlyMap<string, JarvisVoiceReport>,
  input: {
    readonly batch: JarvisVoiceReportBatch;
    readonly identity: string;
    readonly settledReportIds: ReadonlySet<string>;
  },
): {
  readonly reports: Map<string, JarvisVoiceReport>;
  readonly deliveries: readonly JarvisVoiceReportBatch["deliveries"][number][];
  readonly removedReportIds: readonly string[];
} {
  const folded = foldJarvisVoiceReportBatchWithPresentation(previous, input.batch);
  const presentable = (report: JarvisVoiceReport): boolean =>
    isJarvisReportForIdentity(report, input.identity) &&
    !input.settledReportIds.has(report.reportId);
  for (const [reportId, report] of folded.reports) {
    if (!presentable(report)) folded.reports.delete(reportId);
  }
  return {
    reports: folded.reports,
    deliveries: folded.deliveries.filter(({ report }) => presentable(report)),
    removedReportIds: folded.removedReportIds,
  };
}

export function rememberBoundedReportId(
  reportIds: Set<string>,
  reportId: string,
  limit = 512,
): void {
  reportIds.delete(reportId);
  reportIds.add(reportId);
  while (reportIds.size > limit) {
    const oldest = reportIds.values().next().value;
    if (oldest === undefined) break;
    reportIds.delete(oldest);
  }
}

export function truncationStatusIds(input: {
  readonly reports: ReadonlyMap<string, unknown>;
  readonly surfacedReportStatuses: ReadonlyMap<string, unknown>;
  readonly surfacedDeliveryStates: ReadonlyMap<string, unknown>;
}): readonly string[] {
  return [
    ...new Set([
      ...input.reports.keys(),
      ...input.surfacedReportStatuses.keys(),
      ...input.surfacedDeliveryStates.keys(),
    ]),
  ];
}

export function enqueueJarvisPresentation(
  queue: Promise<void>,
  task: () => Promise<void>,
): Promise<void> {
  return queue.then(task);
}

export type JarvisDeliveryResult<A> =
  | { readonly status: "succeeded"; readonly value: A; readonly attempts: number }
  | { readonly status: "exhausted"; readonly attempts: number }
  | { readonly status: "cancelled"; readonly attempts: number };

const DEFAULT_DELIVERY_MAX_ATTEMPTS = 3;
const DEFAULT_DELIVERY_MAX_DURATION_MS = 15_000;

export async function retryJarvisDelivery<A>(input: {
  readonly run: (signal: AbortSignal) => Promise<{ readonly _tag: string; readonly value?: A }>;
  readonly isActive: () => boolean;
  readonly wait: (signal: AbortSignal) => Promise<void>;
  readonly accept?: (value: A) => boolean;
  readonly maxAttempts?: number;
  readonly maxDurationMs?: number;
  readonly now?: () => number;
}): Promise<JarvisDeliveryResult<A>> {
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_DELIVERY_MAX_ATTEMPTS));
  const maxDurationMs = Math.max(0, input.maxDurationMs ?? DEFAULT_DELIVERY_MAX_DURATION_MS);
  const now = input.now ?? Date.now;
  const deadline = now() + maxDurationMs;
  let attempts = 0;
  const abortController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDeadline!: () => void;
  const deadlineReached = new Promise<void>((resolve) => {
    resolveDeadline = resolve;
    deadlineTimer = setTimeout(() => {
      abortController.abort();
      resolve();
    }, maxDurationMs);
  });

  const runUntilDeadline = async <T>(
    operation: () => Promise<T>,
  ): Promise<
    | { readonly _tag: "completed"; readonly value: T }
    | { readonly _tag: "failed" }
    | { readonly _tag: "deadline" }
  > => {
    const operationResult = Promise.resolve()
      .then(operation)
      .then(
        (value) => ({ _tag: "completed" as const, value }),
        () => ({ _tag: "failed" as const }),
      );
    const result = await Promise.race([
      operationResult,
      deadlineReached.then(() => ({ _tag: "deadline" as const })),
    ]);
    return result;
  };

  try {
    while (
      input.isActive() &&
      !abortController.signal.aborted &&
      attempts < maxAttempts &&
      now() < deadline
    ) {
      attempts += 1;
      const result = await runUntilDeadline(() => input.run(abortController.signal));
      if (result._tag === "deadline") {
        return input.isActive()
          ? { status: "exhausted", attempts }
          : { status: "cancelled", attempts };
      }
      const delivery = result._tag === "completed" ? result.value : { _tag: "Failure" };
      if (
        delivery._tag === "Success" &&
        (input.accept === undefined || input.accept(delivery.value as A))
      ) {
        return { status: "succeeded", value: delivery.value as A, attempts };
      }
      if (!input.isActive()) return { status: "cancelled", attempts };
      if (abortController.signal.aborted || attempts >= maxAttempts || now() >= deadline) {
        return { status: "exhausted", attempts };
      }
      const waited = await runUntilDeadline(() => input.wait(abortController.signal));
      if (waited._tag === "deadline") {
        return input.isActive()
          ? { status: "exhausted", attempts }
          : { status: "cancelled", attempts };
      }
    }
    return input.isActive() ? { status: "exhausted", attempts } : { status: "cancelled", attempts };
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    resolveDeadline();
    abortController.abort();
  }
}

export function canMountJarvisVoiceReporter(
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
): boolean {
  return (
    session?.authenticated === true &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true
  );
}

export function speakerPriority(input: {
  /** A paired report-only companion relay must win over every host surface. */
  readonly relay?: boolean;
  readonly preferred: boolean;
  readonly mobile: boolean;
  readonly electron: boolean;
}): number {
  // This renderer exists only in the hidden, paired Windows companion. Giving
  // it a distinct tier avoids a nondeterministic tie with the laptop Electron
  // host (both otherwise have the desktop priority of 75).
  if (input.relay) return 200;
  if (input.preferred) return 100;
  if (input.mobile) return 40;
  return input.electron ? 75 : 60;
}

/** Reports originated by another Companion identity stay on that execution node. */
export function isJarvisReportForIdentity(report: JarvisVoiceReport, identity: string): boolean {
  const origin = report.origin?.originInteractionId;
  return origin === undefined || origin === identity;
}

function normalizedSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " The code details are waiting in your workspace. ")
    .replace(/[`#*_[\]>()]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.!?;:])/gu, "$1")
    .trim();
}

function completedBriefingText(text: string): string {
  return conciseSpeechText(text, 320);
}

function conciseSpeechText(text: string, maximum = 460): string {
  const normalized = normalizedSpeechText(text);
  if (normalized.length <= maximum) return normalized;
  const sentenceEnd = normalized.lastIndexOf(". ", maximum - 1);
  return `${normalized.slice(0, sentenceEnd > 120 ? sentenceEnd + 1 : maximum).trim()}…`;
}

/**
 * The companion mirrors the spoken state, so an answer, question, or failure
 * is still useful at a glance when the person is away from the laptop.
 */
export function companionReportStatus(report: JarvisVoiceReport): {
  readonly state: string;
  readonly detail: string;
  readonly kind: "completed" | "attention" | "error";
} {
  const detail =
    report.kind === "completed"
      ? (report.briefing?.spokenText ?? completedBriefingText(report.text))
      : conciseSpeechText(report.text);
  switch (report.kind) {
    case "work-started":
      return { state: "Working", detail, kind: "attention" };
    case "completed":
      return {
        state: "Finished — short version",
        detail,
        kind: "completed",
      };
    case "waiting-for-input":
      return { state: "I need your input", detail, kind: "attention" };
    case "approval-needed":
      return { state: "One quick approval", detail, kind: "attention" };
    case "failed":
      return { state: "I hit a snag", detail, kind: "error" };
  }
}

export function spokenReportText(report: JarvisVoiceReport): string {
  const output =
    report.kind === "completed"
      ? (report.briefing?.spokenText ?? completedBriefingText(report.text))
      : conciseSpeechText(report.text);
  switch (report.kind) {
    case "work-started":
      return output;
    case "waiting-for-input":
      return output.length > 0 ? `I need one quick detail. ${output}` : "I need one quick detail.";
    case "approval-needed":
      return output.length > 0
        ? `Quick check before I continue. ${output}`
        : "Quick check before I continue.";
    case "failed":
      return output.length > 0
        ? `I hit a snag. ${output}`
        : "I hit a snag. I am waiting for your direction.";
    case "completed":
      return output.length > 0
        ? output
        : "I've finished the task. The details are waiting in your workspace.";
  }
}
