import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const JarvisUtterance = TrimmedNonEmptyString.check(Schema.isMaxLength(16_000));
export type JarvisUtterance = typeof JarvisUtterance.Type;

/** Stable Jarvis node identity; one T3 environment is one MVP execution node. */
export const JarvisNodeId = EnvironmentId;
export type JarvisNodeId = typeof JarvisNodeId.Type;

export const JarvisProjectRef = Schema.Struct({
  nodeId: JarvisNodeId,
  projectId: ProjectId,
});
export type JarvisProjectRef = typeof JarvisProjectRef.Type;

export const JarvisTaskRef = Schema.Struct({
  executionNodeId: JarvisNodeId,
  threadId: ThreadId,
});
export type JarvisTaskRef = typeof JarvisTaskRef.Type;

export const JarvisOriginMetadata = Schema.Struct({
  originNodeId: Schema.optional(JarvisNodeId),
  originInteractionId: Schema.optional(TrimmedNonEmptyString),
});
export type JarvisOriginMetadata = typeof JarvisOriginMetadata.Type;

/** Client-generated request identity. Retrying the same requestId must be idempotent. */
export const JarvisRequestMetadata = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  origin: Schema.optional(JarvisOriginMetadata),
  /** Present only when the instruction came from speech recognition. */
  inputMode: Schema.optional(Schema.Literal("voice")),
  /** Original ASR text retained for diagnostics; never used as the provider prompt. */
  sourceUtterance: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(16_000))),
});
export type JarvisRequestMetadata = typeof JarvisRequestMetadata.Type;

export const JarvisExecuteInput = Schema.Struct({
  projectId: ProjectId,
  /** Node-qualified target for routed calls; local in-process calls may use projectId only. */
  projectRef: Schema.optional(JarvisProjectRef),
  /** Request identity for routed calls; direct local control may omit it. */
  requestMetadata: Schema.optional(JarvisRequestMetadata),
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
  "unsupported-command",
]);
export type JarvisNeedsInputReason = typeof JarvisNeedsInputReason.Type;

export const JarvisNeedsInput = Schema.Struct({
  status: Schema.Literal("needs-input"),
  reason: JarvisNeedsInputReason,
  prompt: TrimmedNonEmptyString,
  choices: Schema.Array(TrimmedNonEmptyString),
});
export type JarvisNeedsInput = typeof JarvisNeedsInput.Type;

export const JarvisExecutionStarted = Schema.Struct({
  status: Schema.Literal("started"),
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  objective: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  acknowledgement: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  taskRef: Schema.optional(JarvisTaskRef),
  requestMetadata: Schema.optional(JarvisRequestMetadata),
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

export const JarvisTaskState = Schema.Literals([
  "running",
  "waiting-for-input",
  "waiting-for-approval",
  "ready",
  "failed",
  "interrupted",
]);
export type JarvisTaskState = typeof JarvisTaskState.Type;

/** Compact persisted identity. Live title, objective, lifecycle, and model data stay in T3. */
export const JarvisTaskDeskTask = Schema.Struct({
  threadId: ThreadId,
  taskRef: JarvisTaskRef,
  projectRef: JarvisProjectRef,
});
export type JarvisTaskDeskTask = typeof JarvisTaskDeskTask.Type;

/** Required live view for clients; never persisted or replayed as desk state. */
export const JarvisTaskDeskTaskView = Schema.Struct({
  threadId: ThreadId,
  taskRef: JarvisTaskRef,
  projectRef: JarvisProjectRef,
  title: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  state: JarvisTaskState,
  modelSelection: ModelSelection,
});
export type JarvisTaskDeskTaskView = typeof JarvisTaskDeskTaskView.Type;

export const JarvisTaskClarificationFrame = Schema.Struct({
  originalUtterance: TrimmedNonEmptyString,
  contextThreadId: Schema.optional(ThreadId),
  referenceThreadId: Schema.optional(ThreadId),
  continueContext: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  requestMetadata: Schema.optional(JarvisRequestMetadata),
  candidates: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      taskRef: Schema.optional(JarvisTaskRef),
      label: TrimmedNonEmptyString,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type JarvisTaskClarificationFrame = typeof JarvisTaskClarificationFrame.Type;

export const JarvisProjectClarificationFrame = Schema.Struct({
  originalUtterance: TrimmedNonEmptyString,
  originProjectId: ProjectId,
  originNodeId: Schema.optional(JarvisNodeId),
  contextThreadId: Schema.optional(ThreadId),
  referenceThreadId: Schema.optional(ThreadId),
  continueContext: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  /** Preserve the client request identity while a project choice is pending. */
  requestMetadata: Schema.optional(JarvisRequestMetadata),
  candidates: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      nodeId: Schema.optional(JarvisNodeId),
      label: TrimmedNonEmptyString,
      learnedAlias: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type JarvisProjectClarificationFrame = typeof JarvisProjectClarificationFrame.Type;

/** The one blocking interaction a session may have at a time. */
export const JarvisPendingInteraction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("task"),
    frame: JarvisTaskClarificationFrame,
  }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    frame: JarvisProjectClarificationFrame,
  }),
]);
export type JarvisPendingInteraction = typeof JarvisPendingInteraction.Type;

export const JarvisProjectAliasKind = Schema.Literals(["confirmed-pronunciation", "user-defined"]);
export type JarvisProjectAliasKind = typeof JarvisProjectAliasKind.Type;

export const JarvisProjectAlias = Schema.Struct({
  projectId: ProjectId,
  /** Local aliases are scoped by their node when projected into a mesh catalog. */
  nodeId: Schema.optional(JarvisNodeId),
  alias: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  kind: JarvisProjectAliasKind,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type JarvisProjectAlias = typeof JarvisProjectAlias.Type;

export const JarvisProjectVocabularyEntry = Schema.Struct({
  projectId: ProjectId,
  nodeId: Schema.optional(JarvisNodeId),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryNames: Schema.Array(TrimmedNonEmptyString),
  aliases: Schema.Array(TrimmedNonEmptyString),
  aliasDetails: Schema.Array(
    Schema.Struct({ alias: TrimmedNonEmptyString, kind: JarvisProjectAliasKind }),
  ),
});
export type JarvisProjectVocabularyEntry = typeof JarvisProjectVocabularyEntry.Type;

export const JarvisProjectVocabulary = Schema.Array(JarvisProjectVocabularyEntry);
export type JarvisProjectVocabulary = typeof JarvisProjectVocabulary.Type;

export const JarvisManageProjectAliasInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("set"),
    projectId: ProjectId,
    nodeId: Schema.optional(JarvisNodeId),
    alias: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    kind: JarvisProjectAliasKind,
  }),
  Schema.Struct({
    action: Schema.Literal("remove"),
    projectId: ProjectId,
    nodeId: Schema.optional(JarvisNodeId),
    alias: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  }),
]);
export type JarvisManageProjectAliasInput = typeof JarvisManageProjectAliasInput.Type;

export const JarvisManageProjectAliasResult = Schema.Struct({ changed: Schema.Boolean });
export type JarvisManageProjectAliasResult = typeof JarvisManageProjectAliasResult.Type;

/** Durable, session-scoped conversation context owned by Jarvis Host. */
export const JarvisTaskDeskState = Schema.Struct({
  focusedTask: Schema.NullOr(JarvisTaskDeskTask),
  recentTasks: Schema.Array(JarvisTaskDeskTask),
  pendingInteraction: Schema.NullOr(JarvisPendingInteraction),
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type JarvisTaskDeskState = typeof JarvisTaskDeskState.Type;

/** Client-facing desk view derived from the current T3 projection. */
export const JarvisTaskDeskView = Schema.Struct({
  focusedTask: Schema.NullOr(JarvisTaskDeskTaskView),
  recentTasks: Schema.Array(JarvisTaskDeskTaskView),
  pendingInteraction: Schema.NullOr(JarvisPendingInteraction),
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type JarvisTaskDeskView = typeof JarvisTaskDeskView.Type;

export const JarvisFocusTaskInput = Schema.Struct({
  threadId: ThreadId,
  taskRef: JarvisTaskRef,
});
export type JarvisFocusTaskInput = typeof JarvisFocusTaskInput.Type;

export const JarvisFocusTaskResult = JarvisTaskDeskView;
export type JarvisFocusTaskResult = typeof JarvisFocusTaskResult.Type;

export const JarvisTaskCreatedActivityPayload = Schema.Struct({
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  messageId: Schema.optional(MessageId),
  modelSelection: Schema.optional(ModelSelection),
  reroutedFromThreadId: Schema.optional(ThreadId),
  taskRef: Schema.optional(JarvisTaskRef),
  requestMetadata: Schema.optional(JarvisRequestMetadata),
});
export type JarvisTaskCreatedActivityPayload = typeof JarvisTaskCreatedActivityPayload.Type;

export const JarvisReviewSourceActivityPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  messageId: Schema.optional(MessageId),
  taskRef: Schema.optional(JarvisTaskRef),
  requestMetadata: Schema.optional(JarvisRequestMetadata),
});
export type JarvisReviewSourceActivityPayload = typeof JarvisReviewSourceActivityPayload.Type;

/** Latest Jarvis interaction that started or resumed work on an existing task. */
export const JarvisTurnOriginActivityPayload = Schema.Struct({
  messageId: Schema.optional(MessageId),
  taskRef: Schema.optional(JarvisTaskRef),
  requestMetadata: JarvisRequestMetadata,
});
export type JarvisTurnOriginActivityPayload = typeof JarvisTurnOriginActivityPayload.Type;

export const JarvisTurnResultFinalizedActivityPayload = Schema.Struct({
  turnId: TurnId,
  userMessageId: Schema.optional(Schema.NullOr(MessageId)),
  assistantMessageId: Schema.NullOr(MessageId),
  state: Schema.Literals(["completed", "failed", "interrupted"]),
});
export type JarvisTurnResultFinalizedActivityPayload =
  typeof JarvisTurnResultFinalizedActivityPayload.Type;

/** A live presentation hint derived from the authoritative T3 event stream. */
export const JarvisPresentationKind = Schema.Literals([
  "completed",
  "waiting-for-input",
  "approval-needed",
  "failed",
]);
export type JarvisPresentationKind = typeof JarvisPresentationKind.Type;

/**
 * Presentation is intentionally not a durable task record. The thread and its
 * pending requests remain in T3; this small DTO exists only while an origin
 * Controller is connected and subscribed to the node that owns the task.
 */
export const JarvisPresentationEvent = Schema.Struct({
  presentationId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  /** Execution identity for routed tasks. */
  taskRef: Schema.optional(JarvisTaskRef),
  /** Only this interaction may receive the live presentation. */
  origin: JarvisOriginMetadata,
  kind: JarvisPresentationKind,
  turnId: Schema.optional(TurnId),
  threadTitle: TrimmedNonEmptyString,
  providerName: TrimmedNonEmptyString,
  /** Short, already-safe text for status UI and speech. Full results stay in T3. */
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(600)),
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
  createdAt: TrimmedNonEmptyString,
});
export type JarvisPresentationEvent = typeof JarvisPresentationEvent.Type;

export const JarvisPresentationSubscriptionInput = Schema.Struct({
  originInteractionId: TrimmedNonEmptyString,
  originNodeId: Schema.optional(JarvisNodeId),
});
export type JarvisPresentationSubscriptionInput = typeof JarvisPresentationSubscriptionInput.Type;

/** Expo token registration is scoped to one authenticated device on one node. */
export const JarvisPushToken = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:Expo|Exponent)PushToken\[[^\]]+\]$/),
);
export type JarvisPushToken = typeof JarvisPushToken.Type;

export const JarvisPushDeviceId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export type JarvisPushDeviceId = typeof JarvisPushDeviceId.Type;

export const JarvisPushRegistrationInput = Schema.Struct({
  token: JarvisPushToken,
  deviceId: JarvisPushDeviceId,
});
export type JarvisPushRegistrationInput = typeof JarvisPushRegistrationInput.Type;

export const JarvisPushRegistrationResult = Schema.Struct({
  registered: Schema.Boolean,
  nodeId: JarvisNodeId,
});
export type JarvisPushRegistrationResult = typeof JarvisPushRegistrationResult.Type;

export class JarvisPushRegistrationError extends Schema.TaggedErrorClass<JarvisPushRegistrationError>()(
  "JarvisPushRegistrationError",
  { message: TrimmedNonEmptyString },
) {}

export const JarvisPushNotificationKind = Schema.Literals([
  "approval-required",
  "needs-input",
  "completed",
  "failed",
]);
export type JarvisPushNotificationKind = typeof JarvisPushNotificationKind.Type;

/** Best-effort push data. The durable task remains the source of truth. */
export const JarvisPushNotificationData = Schema.Struct({
  environmentId: JarvisNodeId,
  threadId: ThreadId,
  kind: JarvisPushNotificationKind,
  notificationId: TrimmedNonEmptyString,
});
export type JarvisPushNotificationData = typeof JarvisPushNotificationData.Type;

export const JarvisExecutionErrorCode = Schema.Literals([
  "project-not-found",
  "node-mismatch",
  "execution-unavailable",
  "request-conflict",
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
