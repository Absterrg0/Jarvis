import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const JarvisUtterance = TrimmedNonEmptyString.check(Schema.isMaxLength(16_000));
export type JarvisUtterance = typeof JarvisUtterance.Type;

export const JarvisExecuteInput = Schema.Struct({
  projectId: ProjectId,
  contextThreadId: Schema.optional(ThreadId),
  /** Exact task reference used for deterministic steering, queueing, status, and interruption. */
  referenceThreadId: Schema.optional(ThreadId),
  /** Continue the supplied context thread even when the utterance is a new instruction. */
  continueContext: Schema.optional(Schema.Boolean),
  utterance: JarvisUtterance,
});
export type JarvisExecuteInput = typeof JarvisExecuteInput.Type;

export const JarvisNeedsInputReason = Schema.Literals([
  "provider-unavailable",
  "provider-not-found",
  "model-unavailable",
  "effort-missing",
  "effort-unavailable",
  "selection-unavailable",
  "objective-missing",
  "context-thread-required",
  "context-project-mismatch",
  "source-output-unavailable",
  "control-target-required",
]);
export type JarvisNeedsInputReason = typeof JarvisNeedsInputReason.Type;

export const JarvisNeedsInput = Schema.Struct({
  status: Schema.Literal("needs-input"),
  reason: JarvisNeedsInputReason,
  prompt: TrimmedNonEmptyString,
  choices: Schema.Array(TrimmedNonEmptyString),
  pendingModelSelection: Schema.optional(ModelSelection),
});
export type JarvisNeedsInput = typeof JarvisNeedsInput.Type;

export const JarvisExecutionStarted = Schema.Struct({
  status: Schema.Literal("started"),
  threadId: ThreadId,
  objective: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
});
export type JarvisExecutionStarted = typeof JarvisExecutionStarted.Type;

export const JarvisExecutionAcknowledged = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("acknowledged"),
    action: Schema.Literals(["steered", "queued", "interrupted", "status"]),
    threadId: ThreadId,
    projectId: ProjectId,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("acknowledged"),
    action: Schema.Literal("focused"),
    projectId: ProjectId,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("acknowledged"),
    action: Schema.Literal("projects-listed"),
    message: TrimmedNonEmptyString,
  }),
]);
export type JarvisExecutionAcknowledged = typeof JarvisExecutionAcknowledged.Type;

export const JarvisExecutionResult = Schema.Union([
  JarvisNeedsInput,
  JarvisExecutionStarted,
  JarvisExecutionAcknowledged,
]);
export type JarvisExecutionResult = typeof JarvisExecutionResult.Type;

export const JarvisTaskDeskTaskState = Schema.Literals([
  "running",
  "waiting-for-input",
  "waiting-for-approval",
  "ready",
  "failed",
  "interrupted",
]);
export type JarvisTaskDeskTaskState = typeof JarvisTaskDeskTaskState.Type;

export const JarvisTaskDeskTask = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  state: JarvisTaskDeskTaskState,
  voiceAliases: Schema.Array(TrimmedNonEmptyString),
});
export type JarvisTaskDeskTask = typeof JarvisTaskDeskTask.Type;

export const JarvisTaskClarificationFrame = Schema.Struct({
  originalUtterance: TrimmedNonEmptyString,
  candidates: Schema.Array(
    Schema.Struct({ threadId: ThreadId, label: TrimmedNonEmptyString }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type JarvisTaskClarificationFrame = typeof JarvisTaskClarificationFrame.Type;

/** Durable, session-scoped conversation focus owned by Jarvis Host. */
export const JarvisTaskDeskState = Schema.Struct({
  focusedThreadId: Schema.NullOr(ThreadId),
  /** Blocking task temporarily receiving replies without rewriting navigation history. */
  attentionThreadId: Schema.NullOr(ThreadId),
  backStack: Schema.Array(ThreadId),
  forwardStack: Schema.Array(ThreadId),
  recentTasks: Schema.Array(JarvisTaskDeskTask),
  pendingFrame: Schema.NullOr(JarvisTaskClarificationFrame),
  newConversationArmed: Schema.Boolean,
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type JarvisTaskDeskState = typeof JarvisTaskDeskState.Type;

export const JarvisTaskDeskNavigation = Schema.Union([
  Schema.Struct({ action: Schema.Literal("back") }),
  Schema.Struct({ action: Schema.Literal("forward") }),
  Schema.Struct({ action: Schema.Literal("new-conversation") }),
  Schema.Struct({ action: Schema.Literal("cancel-new-conversation") }),
  Schema.Struct({ action: Schema.Literal("focus"), threadId: ThreadId }),
]);
export type JarvisTaskDeskNavigation = typeof JarvisTaskDeskNavigation.Type;

export const JarvisTaskDeskNavigationResult = JarvisTaskDeskState;
export type JarvisTaskDeskNavigationResult = typeof JarvisTaskDeskNavigationResult.Type;

export const JarvisTaskDeskEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("task-focused"),
    task: JarvisTaskDeskTask,
    createdAt: Schema.DateTimeUtcFromString,
  }),
  Schema.Struct({
    type: Schema.Literal("task-lifecycle-observed"),
    task: JarvisTaskDeskTask,
    createdAt: Schema.DateTimeUtcFromString,
  }),
  Schema.Struct({
    type: Schema.Literal("navigation-applied"),
    navigation: JarvisTaskDeskNavigation,
    createdAt: Schema.DateTimeUtcFromString,
  }),
  Schema.Struct({
    type: Schema.Literal("clarification-set"),
    frame: JarvisTaskClarificationFrame,
    createdAt: Schema.DateTimeUtcFromString,
  }),
  Schema.Struct({
    type: Schema.Literal("clarification-resolved"),
    threadId: Schema.NullOr(ThreadId),
    createdAt: Schema.DateTimeUtcFromString,
  }),
]);
export type JarvisTaskDeskEvent = typeof JarvisTaskDeskEvent.Type;

export const JarvisVoiceReport = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  kind: Schema.Literals(["completed", "waiting-for-input", "approval-needed", "failed"]),
  threadTitle: TrimmedNonEmptyString,
  providerName: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(16_000)),
  /** Human-facing risk metadata; raw detail remains available visually but is never read by TTS. */
  approvalRisk: Schema.optional(
    Schema.Literals([
      "read",
      "read-and-compute",
      "workspace-write",
      "external-effect",
      "destructive",
      "unknown",
    ]),
  ),
  rawDetail: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  createdAt: TrimmedNonEmptyString,
});
export type JarvisVoiceReport = typeof JarvisVoiceReport.Type;

export const JarvisSpeakerClaimInput = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  deviceId: TrimmedNonEmptyString,
  // A paired companion reserves the high tier so completion reports follow
  // the person, rather than whichever host UI happens to be open.
  priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 })),
});
export type JarvisSpeakerClaimInput = typeof JarvisSpeakerClaimInput.Type;

export const JarvisSpeakerClaimResult = Schema.Struct({ granted: Schema.Boolean });
export type JarvisSpeakerClaimResult = typeof JarvisSpeakerClaimResult.Type;

export const JarvisExecutionErrorCode = Schema.Literals([
  "project-not-found",
  "dispatch-failed",
  "internal-error",
]);
export type JarvisExecutionErrorCode = typeof JarvisExecutionErrorCode.Type;

export class JarvisExecutionError extends Schema.TaggedErrorClass<JarvisExecutionError>()(
  "JarvisExecutionError",
  {
    code: JarvisExecutionErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}
