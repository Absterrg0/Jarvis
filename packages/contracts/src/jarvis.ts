import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
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

/**
 * Pins an answer to the exact pending request it replies to. The controller
 * compares this against the live unique pending before interpreting: a
 * closed request answered late, or an answer landing after a new request
 * opened, is rejected instead of being applied to the wrong request.
 */
export const JarvisExpectedReply = Schema.Struct({
  kind: Schema.Literals(["approval", "input"]),
  requestId: TrimmedNonEmptyString,
});
export type JarvisExpectedReply = typeof JarvisExpectedReply.Type;

/** Unique live pending request projected onto a task view for answer pinning. */
export const JarvisTaskPendingReply = Schema.Struct({
  kind: Schema.Literals(["approval", "user-input"]),
  requestId: TrimmedNonEmptyString,
  questionIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type JarvisTaskPendingReply = typeof JarvisTaskPendingReply.Type;

/**
 * Verbatim utterance for the semantic-proposal bridge. Unlike
 * JarvisUtterance (trimmed), this preserves every character byte-for-byte so
 * cited span offsets validate against the exact source. Clients must send the
 * original transcript untouched; the host rejects spans that do not reproduce
 * it exactly.
 */
export const JarvisVerbatimUtterance = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16_000),
);
export type JarvisVerbatimUtterance = typeof JarvisVerbatimUtterance.Type;

/**
 * Wire mirror of the core semantic-proposal schema. The model proposes, the
 * host authorizes: refs cite exact source spans with typed roles, and only
 * destination/correction can name the project. Defined here (instead of
 * importing jarvis-core) so the generic wire layer stays dependency-free;
 * keep constraints in sync with `semanticEvidence.ts`.
 */
export const JarvisSemanticSourceSpan = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(480)),
});
export type JarvisSemanticSourceSpan = typeof JarvisSemanticSourceSpan.Type;

export const JarvisSemanticRole = Schema.Literals([
  "destination",
  "task",
  "subject",
  "excluded",
  "correction",
  "provider",
]);
export type JarvisSemanticRole = typeof JarvisSemanticRole.Type;

export const JarvisSemanticRef = Schema.Struct({
  span: JarvisSemanticSourceSpan,
  role: JarvisSemanticRole,
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
});
export type JarvisSemanticRef = typeof JarvisSemanticRef.Type;

export const JarvisSemanticProposalAction = Schema.Literals([
  "start",
  "continue",
  "steer",
  "queue",
  "stop",
  "status",
  "review",
  "reroute",
  "focus-project",
  "focus-task",
  "list-projects",
  "converse",
  "unsupported",
]);
export type JarvisSemanticProposalAction = typeof JarvisSemanticProposalAction.Type;

export const JarvisSemanticProposal = Schema.Struct({
  action: JarvisSemanticProposalAction,
  refs: Schema.Array(JarvisSemanticRef),
  model: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  effort: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  answer: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400))),
});
export type JarvisSemanticProposal = typeof JarvisSemanticProposal.Type;

/**
 * Bounded mesh context passed as UNTRUSTED evidence to the interpret call.
 * Names only, never IDs: the semantic node proposes, the client grounds
 * against its real catalog, and the execution node revalidates against its
 * authoritative catalog. A compromised or stale catalog can at most produce
 * a proposal the hosts reject.
 */
export const JarvisInterpretEvidenceProject = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  names: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))),
});
export type JarvisInterpretEvidenceProject = typeof JarvisInterpretEvidenceProject.Type;

export const JarvisInterpretEvidenceTask = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  project: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))),
  objective: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(480))),
  state: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
});
export type JarvisInterpretEvidenceTask = typeof JarvisInterpretEvidenceTask.Type;

export const JarvisInterpretEvidenceProvider = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
});
export type JarvisInterpretEvidenceProvider = typeof JarvisInterpretEvidenceProvider.Type;

export const JarvisInterpretPendingHint = Schema.Literals([
  "none",
  "approval",
  "question",
  "ambiguous",
]);
export type JarvisInterpretPendingHint = typeof JarvisInterpretPendingHint.Type;

/**
 * One semantic inference before irreversible routing. The chosen semantic
 * node runs its configured supervisor once over the verbatim source plus
 * untrusted mesh evidence and returns a typed proposal with no dispatch, no
 * IDs, and no acknowledgement. Pins (expectedReply, context threads) stay on
 * the owner node and are never sent here.
 */
export const JarvisInterpretInput = Schema.Struct({
  utterance: JarvisVerbatimUtterance,
  projects: Schema.Array(JarvisInterpretEvidenceProject),
  tasks: Schema.Array(JarvisInterpretEvidenceTask),
  providers: Schema.Array(JarvisInterpretEvidenceProvider),
  currentProjectTitle: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  ),
  focusedTask: Schema.optional(
    Schema.Struct({
      title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
      project: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))),
    }),
  ),
  continueContext: Schema.optional(Schema.Boolean),
  pendingHint: Schema.optional(JarvisInterpretPendingHint),
  inputMode: Schema.optional(Schema.Literals(["voice", "text"])),
  /**
   * Request identity for pre-accept cancellation of the interpret call
   * itself. Tracked on the semantic node under the same acceptance key
   * derivation as execute; untracked when absent for legacy callers.
   */
  requestMetadata: Schema.optional(JarvisRequestMetadata),
});
export type JarvisInterpretInput = typeof JarvisInterpretInput.Type;

export const JarvisInterpretResult = JarvisSemanticProposal;
export type JarvisInterpretResult = typeof JarvisInterpretResult.Type;

export const JarvisExecuteInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("control").pipe(
      Schema.withDecodingDefault(Effect.succeed("control" as const)),
    ),
    projectId: ProjectId,
    /** Node-qualified target for routed calls; local in-process calls may use projectId only. */
    projectRef: Schema.optional(JarvisProjectRef),
    /** Request identity for routed calls; direct local control may omit it. */
    requestMetadata: Schema.optional(JarvisRequestMetadata),
    /**
     * Answer pin: the pending request this utterance replies to. Null means
     * the snapshot explicitly saw no unique pending request; undefined is a
     * legacy/unknown snapshot that skips verification.
     */
    expectedReply: Schema.optional(Schema.NullOr(JarvisExpectedReply)),
    /**
     * Client-resolved provider/model/options answering a prior model
     * clarification. Typed answers replace English rewriting: the controller
     * validates the selection directly instead of re-parsing the utterance.
     */
    modelSelection: Schema.optional(ModelSelection),
    /** Host-confirmed project identity resuming a durable clarification. */
    confirmedProjectId: Schema.optional(ProjectId),
    /**
     * Binds an answer to the exact clarification frame it replies to.
     * Absent on legacy inputs; new clients always send the known frame.
     */
    clarificationFrameId: Schema.optional(TrimmedNonEmptyString),
    contextThreadId: Schema.optional(ThreadId),
    /** Exact task reference used for deterministic steering, queueing, status, and interruption. */
    referenceThreadId: Schema.optional(ThreadId),
    /** Continue the supplied context thread even when the utterance is a new instruction. */
    continueContext: Schema.optional(Schema.Boolean),
    /**
     * Nonauthoritative proposal from one interpret call. The execution node
     * schema-validates it and revalidates every ref against its authoritative
     * catalog, tasks, providers, and pins; it never authorizes on its own and
     * never triggers a second inference. Absent on direct local calls, which
     * run their single local interpretation instead.
     */
    semanticProposal: Schema.optional(JarvisSemanticProposal),
    /**
     * Verbatim source the proposal cites. Preserved byte-for-byte (no trim)
     * so span offsets validate; when absent the host falls back to
     * `utterance`. New clients always send the untouched transcript here.
     */
    sourceUtterance: Schema.optional(JarvisVerbatimUtterance),
    utterance: JarvisUtterance,
  }),
  /**
   * Project-free conversation: a general question answered directly with no
   * project, task, thread, or provider work. Answers are best-effort and not
   * receipt-backed, so a retry asks the model again instead of replaying.
   * Carries optional request identity so pre-accept cancellation addresses
   * the same acceptance key as control calls; untracked when absent.
   */
  Schema.Struct({
    kind: Schema.Literal("converse"),
    utterance: JarvisUtterance,
    requestMetadata: Schema.optional(JarvisRequestMetadata),
  }),
]);
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

/** Partial provider/model selection carried between typed clarification steps. */
export const JarvisModelDraft = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});
export type JarvisModelDraft = typeof JarvisModelDraft.Type;

export const JarvisNeedsInput = Schema.Struct({
  status: Schema.Literal("needs-input"),
  reason: JarvisNeedsInputReason,
  prompt: TrimmedNonEmptyString,
  choices: Schema.Array(TrimmedNonEmptyString),
  modelDraft: Schema.optional(JarvisModelDraft),
  /**
   * Pins the exact live request this question asks about, so the next answer
   * can carry it as expectedReply even without a desk snapshot in hand.
   */
  expectedReply: Schema.optional(JarvisExpectedReply),
  /** Binds the next answer to the saved frame this question belongs to. */
  clarificationFrameId: Schema.optional(TrimmedNonEmptyString),
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
  /**
   * Accepted-turn correlation for speech: the turn that carries the ack
   * versus later report presentations. Populated from the actual known turn
   * id when the controller accepts; absent when no turn exists yet (new
   * tasks) or the caller predates it. Lets waiting UI match acks to reports
   * without reading wording.
   */
  turnId: Schema.optional(TurnId),
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
    /**
     * Exact task identity for a task focus. Present only for task focus:
     * project focus and cancel paths omit it, and clients must clear any
     * thread when it is absent instead of choosing from the desk.
     */
    taskRef: Schema.optional(JarvisTaskRef),
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("acknowledged"),
    action: Schema.Literal("projects-listed"),
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("acknowledged"),
    action: Schema.Literal("conversed"),
    message: TrimmedNonEmptyString,
  }),
]);
export type JarvisExecutionAcknowledged = typeof JarvisExecutionAcknowledged.Type;

/**
 * A pre-accept cancel won the race against semantic interpretation: the
 * awaiting execute call reports this instead of an acknowledgement, and no
 * provider work was dispatched for the request.
 */
export const JarvisExecutionCancelled = Schema.Struct({
  status: Schema.Literal("cancelled"),
  requestId: TrimmedNonEmptyString,
});
export type JarvisExecutionCancelled = typeof JarvisExecutionCancelled.Type;

export const JarvisExecutionResult = Schema.Union([
  JarvisNeedsInput,
  JarvisExecutionStarted,
  JarvisExecutionAcknowledged,
  JarvisExecutionCancelled,
]);
export type JarvisExecutionResult = typeof JarvisExecutionResult.Type;

/**
 * Pre-accept cancellation identity. The request id plus origin recompute the
 * exact acceptance key of the in-flight execute call; nothing else is needed
 * because cancellation never retargets accepted work.
 */
export const JarvisCancelRequestInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  origin: Schema.optional(JarvisOriginMetadata),
});
export type JarvisCancelRequestInput = typeof JarvisCancelRequestInput.Type;

/**
 * Cancelled means the semantic call was aborted before acceptance and no
 * provider work was dispatched for the request. Already-accepted means the
 * interpretation won the race: accepted work keeps running under the
 * returned identity and must be steered or stopped through its task, never
 * treated as gone. Unknown means no cancellable request is known, so the
 * caller keeps waiting for the execute receipt and reconciles via the desk.
 */
export const JarvisCancelRequestResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    requestId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("already-accepted"),
    requestId: TrimmedNonEmptyString,
    threadId: Schema.optional(ThreadId),
    taskRef: Schema.optional(JarvisTaskRef),
    projectId: Schema.optional(ProjectId),
  }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
    requestId: TrimmedNonEmptyString,
  }),
]);
export type JarvisCancelRequestResult = typeof JarvisCancelRequestResult.Type;

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
  /**
   * The live pending request when exactly one waits, null when none does.
   * Absent only on payloads predating the projection; new reads always set it.
   */
  pendingReply: Schema.optional(Schema.NullOr(JarvisTaskPendingReply)),
});
export type JarvisTaskDeskTaskView = typeof JarvisTaskDeskTaskView.Type;

export const JarvisTaskClarificationFrame = Schema.Struct({
  // frameId binds an answer to the exact clarification it replies to.
  // Optional only to decode desks persisted before the identity existed;
  // new frames always carry one and answers without a match are rejected.
  frameId: Schema.optional(TrimmedNonEmptyString),
  originalUtterance: TrimmedNonEmptyString,
  contextThreadId: Schema.optional(ThreadId),
  referenceThreadId: Schema.optional(ThreadId),
  continueContext: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  requestMetadata: Schema.optional(JarvisRequestMetadata),
  /** Answer pin carried across the choice so the resumed turn still verifies. */
  expectedReply: Schema.optional(Schema.NullOr(JarvisExpectedReply)),
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
  // See JarvisTaskClarificationFrame.frameId: identity for exact-reply binding.
  frameId: Schema.optional(TrimmedNonEmptyString),
  originalUtterance: TrimmedNonEmptyString,
  originProjectId: ProjectId,
  originNodeId: Schema.optional(JarvisNodeId),
  contextThreadId: Schema.optional(ThreadId),
  referenceThreadId: Schema.optional(ThreadId),
  continueContext: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  /** Preserve the client request identity while a project choice is pending. */
  requestMetadata: Schema.optional(JarvisRequestMetadata),
  /** Answer pin carried across the choice so the resumed turn still verifies. */
  expectedReply: Schema.optional(Schema.NullOr(JarvisExpectedReply)),
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
  /** Exact execute request for speech correlation. Optional so old events still decode. */
  requestId: Schema.optional(TrimmedNonEmptyString),
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

export class JarvisPushRegistrationError extends Schema.TaggedError<JarvisPushRegistrationError>()(
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

export class JarvisExecutionError extends Schema.TaggedError<JarvisExecutionError>()(
  "JarvisExecutionError",
  {
    code: JarvisExecutionErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}
