import {
  JarvisReviewSourceActivityPayload,
  JarvisTaskCreatedActivityPayload,
  type JarvisOutcomeBriefing,
  type MessageId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isTaskCreatedPayload = Schema.is(JarvisTaskCreatedActivityPayload);
const isReviewSourcePayload = Schema.is(JarvisReviewSourceActivityPayload);

type StructuredOutcome = {
  readonly status?: "success" | "partial" | "failure" | "interrupted";
  readonly summary?: string;
  readonly findings?: ReadonlyArray<string>;
  readonly changes?: ReadonlyArray<string>;
  readonly checks?: ReadonlyArray<string>;
  readonly blockers?: ReadonlyArray<string>;
  readonly nextActions?: ReadonlyArray<string>;
};

function boundedText(value: string, maximum: number): string {
  if (typeof value !== "string") return "";
  const normalized = value
    // Code is a presentation detail, not a result summary. Drop fenced blocks
    // without trying to interpret the prose around them.
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= maximum) return normalized;
  const sentenceEnd = normalized.lastIndexOf(". ", maximum - 1);
  const end = sentenceEnd > 120 ? sentenceEnd + 1 : maximum - 1;
  return `${normalized.slice(0, end).trim()}…`;
}

function boundedSentences(values: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => boundedText(value, 1_000))
        .filter(Boolean),
    ),
  ].slice(0, 3);
}

function originalGoal(thread: OrchestrationThread, completedAt: string): string {
  const created = thread.activities.findLast(
    (activity) => activity.kind === "jarvis.task.created" && isTaskCreatedPayload(activity.payload),
  );
  if (created !== undefined && isTaskCreatedPayload(created.payload)) {
    return boundedText(created.payload.objective, 1_000);
  }
  const review = thread.activities.findLast(
    (activity) =>
      activity.kind === "jarvis.review.source" && isReviewSourcePayload(activity.payload),
  );
  if (review !== undefined && isReviewSourcePayload(review.payload)) {
    return boundedText(review.payload.objective, 1_000);
  }
  const message = thread.messages.findLast(
    (candidate) => candidate.role === "user" && candidate.createdAt <= completedAt,
  );
  return boundedText(message?.text ?? thread.title, 1_000);
}

function statusLabel(status: StructuredOutcome["status"]): string {
  switch (status) {
    case "success":
      return "Completed";
    case "partial":
      return "Partially completed";
    case "failure":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      return "";
  }
}

function structuredOutcomeText(outcome: StructuredOutcome): string | undefined {
  const summary = outcome.summary === undefined ? "" : boundedText(outcome.summary, 1_000);
  if (summary.length === 0) return undefined;
  const label = statusLabel(outcome.status);
  return label.length > 0 ? `${label}: ${summary}` : summary;
}

/**
 * Formats provider output for speech without assigning meaning to its prose.
 * Status and detail sections are accepted only when a caller supplies them as
 * structured result data. The complete provider result stays in the T3 thread.
 */
export function buildOutcomeBriefing(input: {
  readonly thread: OrchestrationThread;
  readonly messageId: MessageId;
  readonly result: string;
  readonly completedAt: string;
  readonly outcome?: StructuredOutcome;
}): JarvisOutcomeBriefing {
  const structured = input.outcome;
  const providerSummary = boundedText(input.result, 1_000);
  const outcome =
    structuredOutcomeText(structured ?? {}) ??
    (providerSummary.length > 0 ? providerSummary : "The agent did not provide a summary.");
  const findings = boundedSentences(structured?.findings);
  const changeDetails = boundedSentences(structured?.changes);
  const verification = boundedSentences(structured?.checks);
  const limitations = boundedSentences(structured?.blockers);
  const nextActions = boundedSentences(structured?.nextActions);
  const checkpoint = input.thread.checkpoints.find(
    (candidate) => candidate.status === "ready" && candidate.assistantMessageId === input.messageId,
  );
  const changes =
    checkpoint === undefined
      ? undefined
      : {
          fileCount: checkpoint.files.length,
          additions: checkpoint.files.reduce((total, file) => total + file.additions, 0),
          deletions: checkpoint.files.reduce((total, file) => total + file.deletions, 0),
        };
  const spokenText = boundedText(
    [outcome, ...findings, ...changeDetails, ...verification, ...limitations, ...nextActions].join(
      " ",
    ),
    600,
  );

  return {
    goal: originalGoal(input.thread, input.completedAt),
    outcome,
    findings,
    ...(changes === undefined ? {} : { changes }),
    changeDetails,
    verification,
    limitations,
    nextActions,
    spokenText: spokenText.length > 0 ? spokenText : "The agent did not provide a summary.",
  };
}
