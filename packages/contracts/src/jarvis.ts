import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

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
  remoteTaskId: TrimmedNonEmptyString,
  remoteThreadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
  providerId: Schema.optional(ProviderInstanceId),
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
  /** Optional node-qualified target; legacy callers continue to provide projectId only. */
  projectRef: Schema.optional(JarvisProjectRef),
  /** Optional cross-node request identity; local legacy calls omit it. */
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
  projectId: Schema.optional(ProjectId),
  objective: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
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
  /** Node-qualified identity for a routed task; absent on legacy local records. */
  taskRef: Schema.optional(JarvisTaskRef),
  title: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  state: JarvisTaskDeskTaskState,
  voiceAliases: Schema.Array(TrimmedNonEmptyString),
});
export type JarvisTaskDeskTask = typeof JarvisTaskDeskTask.Type;

export const JarvisTaskClarificationFrame = Schema.Struct({
  originalUtterance: TrimmedNonEmptyString,
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

export const JarvisProjectAliasKind = Schema.Literals(["confirmed-pronunciation", "user-defined"]);
export type JarvisProjectAliasKind = typeof JarvisProjectAliasKind.Type;

export const JarvisProjectAlias = Schema.Struct({
  projectId: ProjectId,
  /** Optional for legacy local aliases; new aliases identify their node. */
  nodeId: Schema.optional(JarvisNodeId),
  alias: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  kind: JarvisProjectAliasKind,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type JarvisProjectAlias = typeof JarvisProjectAlias.Type;

export const JarvisProjectAliasEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project-alias-learned"),
    alias: JarvisProjectAlias,
    createdAt: Schema.DateTimeUtcFromString,
  }),
  Schema.Struct({
    type: Schema.Literal("project-alias-forgotten"),
    projectId: ProjectId,
    nodeId: Schema.optional(JarvisNodeId),
    normalizedAlias: TrimmedNonEmptyString,
    createdAt: Schema.DateTimeUtcFromString,
  }),
]);
export type JarvisProjectAliasEvent = typeof JarvisProjectAliasEvent.Type;

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

/** Durable, session-scoped conversation focus owned by Jarvis Host. */
export const JarvisTaskDeskState = Schema.Struct({
  focusedThreadId: Schema.NullOr(ThreadId),
  /** Blocking task temporarily receiving replies without rewriting navigation history. */
  attentionThreadId: Schema.NullOr(ThreadId),
  backStack: Schema.Array(ThreadId),
  forwardStack: Schema.Array(ThreadId),
  recentTasks: Schema.Array(JarvisTaskDeskTask),
  pendingFrame: Schema.NullOr(JarvisTaskClarificationFrame),
  pendingProjectFrame: Schema.NullOr(JarvisProjectClarificationFrame),
  newConversationArmed: Schema.Boolean,
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type JarvisTaskDeskState = typeof JarvisTaskDeskState.Type;

export const JarvisTaskDeskNavigation = Schema.Union([
  Schema.Struct({ action: Schema.Literal("back") }),
  Schema.Struct({ action: Schema.Literal("forward") }),
  Schema.Struct({ action: Schema.Literal("new-conversation") }),
  Schema.Struct({ action: Schema.Literal("cancel-new-conversation") }),
  Schema.Struct({
    action: Schema.Literal("focus"),
    threadId: ThreadId,
    taskRef: Schema.optional(JarvisTaskRef),
  }),
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
  Schema.Struct({
    type: Schema.Literal("project-clarification-set"),
    frame: JarvisProjectClarificationFrame,
    createdAt: Schema.DateTimeUtcFromString,
  }),
  Schema.Struct({
    type: Schema.Literal("project-clarification-cleared"),
    createdAt: Schema.DateTimeUtcFromString,
  }),
]);
export type JarvisTaskDeskEvent = typeof JarvisTaskDeskEvent.Type;

const JarvisBriefingSentence = TrimmedNonEmptyString.check(Schema.isMaxLength(1_000));
export const JarvisOutcomeBriefing = Schema.Struct({
  goal: JarvisBriefingSentence,
  outcome: JarvisBriefingSentence,
  findings: Schema.Array(JarvisBriefingSentence).check(Schema.isMaxLength(3)),
  changes: Schema.optional(
    Schema.Struct({
      fileCount: NonNegativeInt,
      additions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
  changeDetails: Schema.Array(JarvisBriefingSentence).check(Schema.isMaxLength(3)),
  verification: Schema.Array(JarvisBriefingSentence).check(Schema.isMaxLength(3)),
  limitations: Schema.Array(JarvisBriefingSentence).check(Schema.isMaxLength(3)),
  nextActions: Schema.Array(JarvisBriefingSentence).check(Schema.isMaxLength(3)),
  spokenText: TrimmedNonEmptyString.check(Schema.isMaxLength(600)),
});
export type JarvisOutcomeBriefing = typeof JarvisOutcomeBriefing.Type;

export const JarvisTaskCreatedActivityPayload = Schema.Struct({
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  modelSelection: Schema.optional(ModelSelection),
  reroutedFromThreadId: Schema.optional(ThreadId),
  /** Present when a replacement successor was created for another provider. */
  replacedProviderFromThreadId: Schema.optional(ThreadId),
  taskRef: Schema.optional(JarvisTaskRef),
  requestMetadata: Schema.optional(JarvisRequestMetadata),
});
export type JarvisTaskCreatedActivityPayload = typeof JarvisTaskCreatedActivityPayload.Type;

export const JarvisReviewSourceActivityPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
});
export type JarvisReviewSourceActivityPayload = typeof JarvisReviewSourceActivityPayload.Type;

export const JarvisTurnResultFinalizedActivityPayload = Schema.Struct({
  turnId: TurnId,
  assistantMessageId: Schema.NullOr(MessageId),
  state: Schema.Literals(["completed", "failed", "interrupted"]),
});
export type JarvisTurnResultFinalizedActivityPayload =
  typeof JarvisTurnResultFinalizedActivityPayload.Type;

export const JarvisVoiceReport = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  /** Execution identity for reports produced by a routed task. */
  taskRef: Schema.optional(JarvisTaskRef),
  /** Origin interaction receives priority when several nodes can speak a report. */
  origin: Schema.optional(JarvisOriginMetadata),
  kind: Schema.Literals(["completed", "waiting-for-input", "approval-needed", "failed"]),
  threadTitle: TrimmedNonEmptyString,
  providerName: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(16_000)),
  /** Host-projected facts for concise presentation; text remains the complete provider result. */
  briefing: Schema.optional(JarvisOutcomeBriefing),
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

export const JarvisVoiceReportDelivery = Schema.Struct({
  sequence: NonNegativeInt,
  report: JarvisVoiceReport,
});
export type JarvisVoiceReportDelivery = typeof JarvisVoiceReportDelivery.Type;

export const JarvisVoiceReportBatch = Schema.Struct({
  acknowledgedThrough: NonNegativeInt,
  batchThrough: NonNegativeInt,
  deliveries: Schema.Array(JarvisVoiceReportDelivery).check(Schema.isMaxLength(32)),
  hasMore: Schema.Boolean,
  truncatedBefore: Schema.optional(NonNegativeInt),
});
export type JarvisVoiceReportBatch = typeof JarvisVoiceReportBatch.Type;

export const JarvisAcknowledgeVoiceReportInput = Schema.Struct({
  throughSequence: NonNegativeInt,
  /** Stable Companion/browser identity used to resume the same inbox cursor. */
  originInteractionId: Schema.optional(TrimmedNonEmptyString),
});
export type JarvisAcknowledgeVoiceReportInput = typeof JarvisAcknowledgeVoiceReportInput.Type;

export const JarvisAcknowledgeVoiceReportResult = Schema.Struct({
  acknowledgedThrough: NonNegativeInt,
});
export type JarvisAcknowledgeVoiceReportResult = typeof JarvisAcknowledgeVoiceReportResult.Type;

export const JarvisSpeakerClaimInput = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  deviceId: TrimmedNonEmptyString,
  // A paired companion reserves the high tier so completion reports follow
  // the person, rather than whichever host UI happens to be open.
  priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 })),
});
export type JarvisSpeakerClaimInput = typeof JarvisSpeakerClaimInput.Type;

export const JarvisSpeakerClaimResult = Schema.Struct({
  granted: Schema.Boolean,
  speechState: Schema.optional(
    Schema.Literals(["claimed", "leased", "already-spoken", "missing", "legacy"]),
  ),
});
export type JarvisSpeakerClaimResult = typeof JarvisSpeakerClaimResult.Type;

export const JarvisSpeechConfirmationInput = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  deviceId: TrimmedNonEmptyString,
});
export type JarvisSpeechConfirmationInput = typeof JarvisSpeechConfirmationInput.Type;

export const JarvisSpeechConfirmationResult = Schema.Struct({
  confirmed: Schema.Boolean,
  state: Schema.Literals(["confirmed", "already-spoken", "lease-lost", "missing"]),
});
export type JarvisSpeechConfirmationResult = typeof JarvisSpeechConfirmationResult.Type;

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
