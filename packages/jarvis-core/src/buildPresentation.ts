import {
  JarvisTaskCreatedActivityPayload,
  JarvisReviewSourceActivityPayload,
  JarvisTurnResultFinalizedActivityPayload,
  JarvisTurnOriginActivityPayload,
  MessageId,
  type JarvisPresentationEvent,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { describeApproval } from "./describeApproval.ts";

const isTurnResultFinalizedPayload = Schema.is(JarvisTurnResultFinalizedActivityPayload);
const decodeTaskCreatedPayload = Schema.decodeUnknownOption(JarvisTaskCreatedActivityPayload);
const decodeReviewSourcePayload = Schema.decodeUnknownOption(JarvisReviewSourceActivityPayload);
const decodeTurnOriginPayload = Schema.decodeUnknownOption(JarvisTurnOriginActivityPayload);

type PresentationCorrelation = {
  readonly turnId?: TurnId;
  readonly userMessageId?: MessageId | null;
  readonly occurredAt?: string;
};

function routedPresentationMetadata(
  thread: OrchestrationThread,
  correlation: PresentationCorrelation = {},
): {
  readonly taskRef?: JarvisPresentationEvent["taskRef"];
  readonly origin?: JarvisPresentationEvent["origin"];
} {
  const decodeMarker = (marker: OrchestrationThreadActivity | undefined) => {
    if (marker?.kind === "jarvis.task.created") {
      return Option.getOrUndefined(decodeTaskCreatedPayload(marker.payload));
    }
    if (marker?.kind === "jarvis.review.source") {
      return Option.getOrUndefined(decodeReviewSourcePayload(marker.payload));
    }
    if (marker?.kind === "jarvis.turn.origin") {
      return Option.getOrUndefined(decodeTurnOriginPayload(marker.payload));
    }
    return undefined;
  };
  const markerPayloads = thread.activities.flatMap((activity) => {
    const payload = decodeMarker(activity);
    return payload === undefined ? [] : [{ activity, payload }];
  });
  const identityPayload = markerPayloads.findLast(({ payload }) => payload.taskRef !== undefined);
  const eligibleOriginPayloads = markerPayloads.filter(
    ({ activity, payload }) =>
      payload.requestMetadata?.origin !== undefined &&
      (correlation.occurredAt === undefined || activity.createdAt <= correlation.occurredAt) &&
      (payload.messageId === undefined ||
        thread.messages.some((message) => message.id === payload.messageId)),
  );
  const exactOriginPayload = eligibleOriginPayloads.findLast(
    ({ activity, payload }) =>
      (correlation.userMessageId !== undefined &&
        correlation.userMessageId !== null &&
        payload.messageId === correlation.userMessageId) ||
      (correlation.turnId !== undefined && activity.turnId === correlation.turnId),
  );
  const originPayload =
    correlation.userMessageId !== undefined && correlation.userMessageId !== null
      ? exactOriginPayload
      : (exactOriginPayload ?? eligibleOriginPayloads.at(-1));
  return {
    ...(identityPayload?.payload.taskRef === undefined
      ? {}
      : { taskRef: identityPayload.payload.taskRef }),
    ...(originPayload?.payload.requestMetadata?.origin === undefined
      ? {}
      : { origin: originPayload.payload.requestMetadata.origin }),
  };
}

function isJarvisManagedThread(thread: OrchestrationThread): boolean {
  return thread.activities.some(
    (activity) =>
      activity.kind === "jarvis.task.created" || activity.kind === "jarvis.review.source",
  );
}

function boundedPresentationText(value: string): string {
  const normalized = value
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return "The agent did not provide a summary.";
  if (normalized.length <= 600) return normalized;
  const sentenceEnd = normalized.lastIndexOf(". ", 599);
  const end = sentenceEnd > 120 ? sentenceEnd + 1 : 599;
  return `${normalized.slice(0, end).trim()}…`;
}

/** Build a speakable presentation only for tasks that were created by the T3 manager. */
export function buildCompletedPresentation(
  thread: OrchestrationThread,
  messageId?: MessageId,
  presentationId?: string,
  correlation?: PresentationCorrelation,
): JarvisPresentationEvent | null {
  if (!isJarvisManagedThread(thread)) {
    return null;
  }
  const metadata = routedPresentationMetadata(thread, correlation);
  if (metadata.origin === undefined) return null;
  const { origin } = metadata;
  const message =
    messageId === undefined
      ? thread.messages.findLast(
          (candidate) => candidate.role === "assistant" && !candidate.streaming,
        )
      : thread.messages.find(
          (candidate) =>
            candidate.id === messageId && candidate.role === "assistant" && !candidate.streaming,
        );
  if (!message) return null;
  const result = boundedPresentationText(message.text);

  return {
    presentationId: presentationId ?? message.id,
    projectId: thread.projectId,
    threadId: thread.id,
    ...(metadata.taskRef === undefined ? {} : { taskRef: metadata.taskRef }),
    origin,
    kind: "completed",
    ...(message.turnId === null ? {} : { turnId: message.turnId }),
    threadTitle: thread.title,
    providerName: thread.session?.providerName ?? thread.modelSelection.instanceId,
    text: result,
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

/** Build a blocker/error presentation from the exact activity that triggered the subscription. */
export function buildActivityPresentation(
  thread: OrchestrationThread,
  activityId: string,
  projectTitle = "this project",
): JarvisPresentationEvent | null {
  const activity = thread.activities.find((candidate) => candidate.id === activityId);
  return activity ? buildActivityPresentationForActivity(thread, activity, projectTitle) : null;
}

export function buildActivityPresentationForActivity(
  thread: OrchestrationThread,
  activity: OrchestrationThreadActivity,
  projectTitle = "this project",
): JarvisPresentationEvent | null {
  if (!isJarvisManagedThread(thread)) return null;
  // Checkpoint capture/revert is optional workspace bookkeeping. A warning
  // here must never replace the task's later completed result.
  if (
    activity.kind === "checkpoint.capture.failed" ||
    activity.kind === "checkpoint.revert.failed"
  ) {
    return null;
  }
  const payload = payloadRecord(activity);
  const finalizedPayload =
    activity.kind === "provider.turn.result-finalized" &&
    isTurnResultFinalizedPayload(activity.payload)
      ? activity.payload
      : undefined;
  const metadata = routedPresentationMetadata(thread, {
    ...(activity.turnId === null ? {} : { turnId: activity.turnId }),
    ...(finalizedPayload?.userMessageId === undefined
      ? {}
      : { userMessageId: finalizedPayload.userMessageId }),
    occurredAt: activity.createdAt,
  });
  if (metadata.origin === undefined) return null;
  const { origin } = metadata;
  const presentationBase = {
    presentationId: activity.id,
    projectId: thread.projectId,
    threadId: thread.id,
    ...(metadata.taskRef === undefined ? {} : { taskRef: metadata.taskRef }),
    origin,
    threadTitle: thread.title,
    providerName: thread.session?.providerName ?? thread.modelSelection.instanceId,
    createdAt: activity.createdAt,
    ...(activity.turnId === null ? {} : { turnId: activity.turnId }),
  } as const;

  if (activity.kind === "provider.turn.result-finalized") {
    if (!isTurnResultFinalizedPayload(activity.payload)) return null;
    if (activity.payload.state === "interrupted") return null;
    if (activity.payload.state === "completed") {
      const completed =
        activity.payload.assistantMessageId === null
          ? null
          : buildCompletedPresentation(thread, activity.payload.assistantMessageId, activity.id, {
              turnId: activity.payload.turnId,
              ...(activity.payload.userMessageId === undefined
                ? {}
                : { userMessageId: activity.payload.userMessageId }),
              occurredAt: activity.createdAt,
            });
      if (completed !== null) return completed;
      return {
        ...presentationBase,
        kind: "completed",
        text: "The agent finished the task.",
      };
    }
    return {
      ...presentationBase,
      kind: "failed",
      text: "The provider turn failed.",
    };
  }

  if (activity.kind === "user-input.requested") {
    return {
      ...presentationBase,
      kind: "waiting-for-input",
      text: questionText(payload) ?? "The agent is waiting for your input.",
    };
  }
  if (activity.kind === "approval.requested") {
    const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
    const requestKind = typeof payload.requestKind === "string" ? payload.requestKind : undefined;
    const requestType = typeof payload.requestType === "string" ? payload.requestType : undefined;
    const appName = typeof payload.appName === "string" ? payload.appName : undefined;
    const risk = typeof payload.risk === "string" ? payload.risk : undefined;
    const args = payload.args;
    const structuredToolName =
      typeof args === "object" && args !== null && "toolName" in args ? args.toolName : undefined;
    const structuredCommand =
      typeof args === "object" && args !== null && "command" in args ? args.command : undefined;
    const structuredRisk =
      typeof args === "object" && args !== null && "risk" in args ? args.risk : undefined;
    const toolName =
      typeof payload.toolName === "string"
        ? payload.toolName
        : typeof structuredToolName === "string"
          ? structuredToolName
          : appName;
    const command =
      typeof payload.command === "string"
        ? payload.command
        : typeof structuredCommand === "string"
          ? structuredCommand
          : Array.isArray(structuredCommand) &&
              structuredCommand.every((part) => typeof part === "string")
            ? structuredCommand.join(" ")
            : undefined;
    const structuredRiskName =
      typeof risk === "string"
        ? risk
        : typeof structuredRisk === "string"
          ? structuredRisk
          : undefined;
    const description = describeApproval({
      ...(requestKind === undefined ? {} : { requestKind }),
      ...(requestType === undefined ? {} : { requestType }),
      ...(toolName === undefined ? {} : { toolName }),
      ...(command === undefined ? {} : { command }),
      ...(structuredRiskName === undefined ? {} : { risk: structuredRiskName }),
      detail,
      projectTitle,
    });
    return {
      ...presentationBase,
      kind: "approval-needed",
      text: description.spoken,
      approvalRisk: description.risk,
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
        ...presentationBase,
        kind: "failed",
        text: approval
          ? `I couldn't send that approval because the request is no longer open. ${detail}`
          : `I couldn't send that response because the request is no longer open. ${detail}`,
      };
    }
    return {
      ...presentationBase,
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
      ...presentationBase,
      kind: "failed",
      text: message.length > 0 ? message.slice(0, 16_000) : activity.summary,
    };
  }
  return null;
}

/** Session errors are presented here; successful completion requires the correlated activity. */
export function buildSessionPresentation(
  thread: OrchestrationThread,
  session: OrchestrationSession,
  presentationId: string,
): JarvisPresentationEvent | null {
  if (session.status === "error") {
    if (!isJarvisManagedThread(thread)) return null;
    const metadata = routedPresentationMetadata(thread, {
      ...(session.activeTurnId === null ? {} : { turnId: session.activeTurnId }),
      occurredAt: session.updatedAt,
    });
    if (metadata.origin === undefined) return null;
    const { origin } = metadata;
    return {
      presentationId,
      projectId: thread.projectId,
      threadId: thread.id,
      ...(metadata.taskRef === undefined ? {} : { taskRef: metadata.taskRef }),
      origin,
      kind: "failed",
      ...(session.activeTurnId === null ? {} : { turnId: session.activeTurnId }),
      threadTitle: thread.title,
      providerName: session.providerName ?? thread.modelSelection.instanceId,
      text: session.lastError ?? "The provider turn failed.",
      createdAt: session.updatedAt,
    };
  }
  return null;
}
