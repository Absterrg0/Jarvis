import {
  JarvisTurnResultFinalizedActivityPayload,
  MessageId,
  type JarvisVoiceReport,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { describeApproval } from "./describeApproval.ts";
import { buildOutcomeBriefing } from "./buildOutcomeBriefing.ts";

const isTurnResultFinalizedPayload = Schema.is(JarvisTurnResultFinalizedActivityPayload);

function isJarvisManagedThread(thread: OrchestrationThread): boolean {
  return thread.activities.some(
    (activity) =>
      activity.kind === "jarvis.task.created" || activity.kind === "jarvis.review.source",
  );
}

/** Build a speakable report only for tasks that were created by the T3 manager. */
export function buildCompletedVoiceReport(
  thread: OrchestrationThread,
  messageId?: MessageId,
): JarvisVoiceReport | null {
  if (!isJarvisManagedThread(thread)) {
    return null;
  }
  const message =
    messageId === undefined
      ? thread.messages.findLast(
          (candidate) => candidate.role === "assistant" && !candidate.streaming,
        )
      : thread.messages.find(
          (candidate) =>
            candidate.id === messageId && candidate.role === "assistant" && !candidate.streaming,
        );
  if (!message || message.text.trim().length === 0) return null;

  return {
    reportId: message.id,
    projectId: thread.projectId,
    threadId: thread.id,
    kind: "completed",
    threadTitle: thread.title,
    providerName: thread.session?.providerName ?? thread.modelSelection.instanceId,
    text: message.text.trim().slice(0, 16_000),
    briefing: buildOutcomeBriefing({
      thread,
      messageId: message.id,
      result: message.text.trim(),
      completedAt: message.updatedAt,
    }),
    createdAt: message.updatedAt,
  };
}

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : {};
}

function questionText(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.questions)) return null;
  const questions = (payload.questions as ReadonlyArray<unknown>).flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const question = "question" in candidate ? candidate.question : null;
    if (typeof question !== "string" || question.trim().length === 0) return [];
    const options =
      "options" in candidate && Array.isArray(candidate.options)
        ? (candidate.options as ReadonlyArray<unknown>).flatMap((option) => {
            if (typeof option !== "object" || option === null || !("label" in option)) return [];
            return typeof option.label === "string" ? [option.label] : [];
          })
        : [];
    return [options.length > 0 ? `${question} Options: ${options.join(", ")}.` : question];
  });
  return questions.length > 0 ? questions.join(" ") : null;
}

export function isClosedPendingRequestDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
  );
}

/** Build blocked/error reports from the exact activity that triggered the subscription. */
export function buildActivityVoiceReport(
  thread: OrchestrationThread,
  activityId: string,
  projectTitle = "this project",
): JarvisVoiceReport | null {
  const activity = thread.activities.find((candidate) => candidate.id === activityId);
  return activity ? buildActivityVoiceReportForActivity(thread, activity, projectTitle) : null;
}

export function buildActivityVoiceReportForActivity(
  thread: OrchestrationThread,
  activity: OrchestrationThreadActivity,
  projectTitle = "this project",
): JarvisVoiceReport | null {
  if (!isJarvisManagedThread(thread)) return null;
  const payload = payloadRecord(activity);
  const reportBase = {
    reportId: activity.id,
    projectId: thread.projectId,
    threadId: thread.id,
    threadTitle: thread.title,
    providerName: thread.session?.providerName ?? thread.modelSelection.instanceId,
    createdAt: activity.createdAt,
  } as const;

  if (
    activity.kind === "jarvis.turn.completion-ready" &&
    isTurnResultFinalizedPayload(activity.payload) &&
    activity.payload.state === "completed" &&
    activity.payload.assistantMessageId !== null
  ) {
    return buildCompletedVoiceReport(thread, activity.payload.assistantMessageId);
  }

  if (activity.kind === "user-input.requested") {
    return {
      ...reportBase,
      kind: "waiting-for-input",
      text: questionText(payload) ?? "The agent is waiting for your input.",
    };
  }
  if (activity.kind === "approval.requested") {
    const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
    const requestKind = typeof payload.requestKind === "string" ? payload.requestKind : undefined;
    const description = describeApproval({
      ...(requestKind === undefined ? {} : { requestKind }),
      detail,
      projectTitle,
    });
    return {
      ...reportBase,
      kind: "approval-needed",
      text: description.spoken,
      approvalRisk: description.risk,
      ...(description.rawDetail.length === 0
        ? {}
        : { rawDetail: description.rawDetail.slice(0, 16_000) }),
    };
  }
  if (
    activity.kind === "provider.user-input.respond.failed" ||
    activity.kind === "provider.approval.respond.failed"
  ) {
    const detail =
      typeof payload.message === "string"
        ? payload.message.trim()
        : typeof payload.detail === "string"
          ? payload.detail.trim()
          : "The provider did not accept the response.";
    const approval = activity.kind === "provider.approval.respond.failed";
    if (isClosedPendingRequestDetail(detail)) {
      return {
        ...reportBase,
        kind: "failed",
        text: approval
          ? `I couldn't send that approval because the request is no longer open. ${detail}`
          : `I couldn't send that response because the request is no longer open. ${detail}`,
      };
    }
    return {
      ...reportBase,
      kind: approval ? "approval-needed" : "waiting-for-input",
      text: approval
        ? `I couldn't send that approval. The task still needs your decision. ${detail}`
        : `I couldn't send that response. The task is still waiting for your input. ${detail}`,
    };
  }
  if (activity.kind === "runtime.error" || activity.kind.endsWith(".failed")) {
    const message =
      typeof payload.message === "string"
        ? payload.message.trim()
        : typeof payload.detail === "string"
          ? payload.detail.trim()
          : "";
    return {
      ...reportBase,
      kind: "failed",
      text: message.length > 0 ? message.slice(0, 16_000) : activity.summary,
    };
  }
  return null;
}

/** Session errors are reported here; successful completion requires the correlated activity. */
export function buildSessionVoiceReport(
  thread: OrchestrationThread,
  session: OrchestrationSession,
  reportId: string,
): JarvisVoiceReport | null {
  if (session.status === "error") {
    if (!isJarvisManagedThread(thread)) return null;
    return {
      reportId,
      projectId: thread.projectId,
      threadId: thread.id,
      kind: "failed",
      threadTitle: thread.title,
      providerName: session.providerName ?? thread.modelSelection.instanceId,
      text: session.lastError ?? "The provider turn failed.",
      createdAt: session.updatedAt,
    };
  }
  return null;
}
