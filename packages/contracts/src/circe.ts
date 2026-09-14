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

export const CirceUtterance = TrimmedNonEmptyString.check(Schema.isMaxLength(16_000));
export type CirceUtterance = typeof CirceUtterance.Type;

/** Stable Circe node identity; one T3 environment is one MVP execution node. */
export const CirceNodeId = EnvironmentId;
export type CirceNodeId = typeof CirceNodeId.Type;

export const CirceProjectRef = Schema.Struct({
  nodeId: CirceNodeId,
  projectId: ProjectId,
});
export type CirceProjectRef = typeof CirceProjectRef.Type;

export const CirceTaskRef = Schema.Struct({
  executionNodeId: CirceNodeId,
  threadId: ThreadId,
});
export type CirceTaskRef = typeof CirceTaskRef.Type;

export const CirceOriginMetadata = Schema.Struct({
  originNodeId: Schema.optional(CirceNodeId),
  originInteractionId: Schema.optional(TrimmedNonEmptyString),
});
export type CirceOriginMetadata = typeof CirceOriginMetadata.Type;

/** Client-generated request identity. Retrying the same requestId must be idempotent. */
export const CirceRequestMetadata = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  origin: Schema.optional(CirceOriginMetadata),
  /** Present only when the instruction came from speech recognition. */
  inputMode: Schema.optional(Schema.Literal("voice")),
  /** Original ASR text retained for diagnostics; never used as the provider prompt. */
  sourceUtterance: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(16_000))),
});
export type CirceRequestMetadata = typeof CirceRequestMetadata.Type;

/**
 * Pins an answer to the exact pending request it replies to. The controller
 * compares this against the live unique pending before interpreting: a
 * closed request answered late, or an answer landing after a new request
 * opened, is rejected instead of being applied to the wrong request.
 */
export const CirceExpectedReply = Schema.Struct({
  kind: Schema.Literals(["approval", "input"]),
  requestId: TrimmedNonEmptyString,
});
export type CirceExpectedReply = typeof CirceExpectedReply.Type;

/** Unique live pending request projected onto a task view for answer pinning. */
export const CirceTaskPendingReply = Schema.Struct({
  kind: Schema.Literals(["approval", "user-input"]),
  requestId: TrimmedNonEmptyString,
  questionIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type CirceTaskPendingReply = typeof CirceTaskPendingReply.Type;

/**
 * Verbatim utterance for the semantic-proposal bridge. Unlike
 * CirceUtterance (trimmed), this preserves every character byte-for-byte so
 * cited span offsets validate against the exact source. Clients must send the
 * original transcript untouched; the host rejects spans that do not reproduce
 * it exactly.
 */
export const CirceVerbatimUtterance = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16_000),
);
export type CirceVerbatimUtterance = typeof CirceVerbatimUtterance.Type;

/**
 * Wire mirror of the core semantic-proposal schema. The model proposes, the
 * host authorizes: refs cite exact source spans with typed roles, and only
 * destination/correction can name the project. Defined here (instead of
 * importing circe-core) so the generic wire layer stays dependency-free;
 * keep constraints in sync with `semanticEvidence.ts`.
 */
export const CirceSemanticSourceSpan = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(480)),
});
export type CirceSemanticSourceSpan = typeof CirceSemanticSourceSpan.Type;

export const CirceSemanticRole = Schema.Literals([
  "destination",
  "task",
  "subject",
  "excluded",
  "correction",
  "provider",
]);
export type CirceSemanticRole = typeof CirceSemanticRole.Type;

export const CirceSemanticRef = Schema.Struct({
  span: CirceSemanticSourceSpan,
  role: CirceSemanticRole,
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
});
export type CirceSemanticRef = typeof CirceSemanticRef.Type;

export const CirceSemanticProposalAction = Schema.Literals([
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
  "lookup",
  "open-website",
  "unsupported",
  "sequence",
]);
export type CirceSemanticProposalAction = typeof CirceSemanticProposalAction.Type;

/** Bounded assistant lookup payload; the place must appear in the source. */
export const CirceSemanticLookup = Schema.Struct({
  kind: Schema.Literals(["weather", "time"]),
  location: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  day: Schema.Literals(["now", "today", "tomorrow"]),
});
export type CirceSemanticLookup = typeof CirceSemanticLookup.Type;

/** A single command inside a multi-command turn; steps never nest. */
export const CirceSemanticStepAction = Schema.Literals([
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
]);
export type CirceSemanticStepAction = typeof CirceSemanticStepAction.Type;

export const CirceSemanticStep = Schema.Struct({
  action: CirceSemanticStepAction,
  refs: Schema.Array(CirceSemanticRef),
  model: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  effort: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  answer: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400))),
});
export type CirceSemanticStep = typeof CirceSemanticStep.Type;

export const CirceSemanticProposal = Schema.Struct({
  action: CirceSemanticProposalAction,
  refs: Schema.Array(CirceSemanticRef),
  model: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  effort: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  answer: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400))),
  /** Present only when action is lookup; the host requires the place in source. */
  lookup: Schema.optional(Schema.NullOr(CirceSemanticLookup)),
  /** Present only when action is open-website: a named site or web URL. */
  website: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))),
  ),
  /**
   * Ordered, independent commands for one turn. Present only for `sequence`,
   * bounded, and executed in order by the host. Steps never nest.
   */
  steps: Schema.optional(Schema.Array(CirceSemanticStep)),
});
export type CirceSemanticProposal = typeof CirceSemanticProposal.Type;

/**
 * Bounded mesh context passed as UNTRUSTED evidence to the interpret call.
 * Names only, never IDs: the semantic node proposes, the client grounds
 * against its real catalog, and the execution node revalidates against its
 * authoritative catalog. A compromised or stale catalog can at most produce
 * a proposal the hosts reject.
 */
export const CirceInterpretEvidenceProject = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  names: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))),
});
export type CirceInterpretEvidenceProject = typeof CirceInterpretEvidenceProject.Type;

export const CirceInterpretEvidenceTask = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  project: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))),
  objective: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(480))),
  state: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
});
export type CirceInterpretEvidenceTask = typeof CirceInterpretEvidenceTask.Type;

export const CirceInterpretEvidenceProvider = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
});
export type CirceInterpretEvidenceProvider = typeof CirceInterpretEvidenceProvider.Type;

export const CirceInterpretPendingHint = Schema.Literals([
  "none",
  "approval",
  "question",
  "ambiguous",
]);
export type CirceInterpretPendingHint = typeof CirceInterpretPendingHint.Type;

/**
 * One semantic inference before irreversible routing. The chosen semantic
 * node runs its configured supervisor once over the verbatim source plus
 * untrusted mesh evidence and returns a typed proposal with no dispatch, no
 * IDs, and no acknowledgement. Pins (expectedReply, context threads) stay on
 * the owner node and are never sent here.
 */
export const CirceInterpretInput = Schema.Struct({
  utterance: CirceVerbatimUtterance,
  projects: Schema.Array(CirceInterpretEvidenceProject),
  tasks: Schema.Array(CirceInterpretEvidenceTask),
  providers: Schema.Array(CirceInterpretEvidenceProvider),
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
  pendingHint: Schema.optional(CirceInterpretPendingHint),
  inputMode: Schema.optional(Schema.Literals(["voice", "text"])),
  /**
   * Request identity for pre-accept cancellation of the interpret call
   * itself. Tracked on the semantic node under the same acceptance key
   * derivation as execute; untracked when absent for legacy callers.
   */
  requestMetadata: Schema.optional(CirceRequestMetadata),
});
export type CirceInterpretInput = typeof CirceInterpretInput.Type;

export const CirceInterpretResult = CirceSemanticProposal;
export type CirceInterpretResult = typeof CirceInterpretResult.Type;

export const CirceExecuteInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("control").pipe(
      Schema.withDecodingDefault(Effect.succeed("control" as const)),
    ),
    projectId: ProjectId,
    /** Node-qualified target for routed calls; local in-process calls may use projectId only. */
    projectRef: Schema.optional(CirceProjectRef),
    /** Request identity for routed calls; direct local control may omit it. */
    requestMetadata: Schema.optional(CirceRequestMetadata),
    /**
     * Answer pin: the pending request this utterance replies to. Null means
     * the snapshot explicitly saw no unique pending request; undefined is a
     * legacy/unknown snapshot that skips verification.
     */
    expectedReply: Schema.optional(Schema.NullOr(CirceExpectedReply)),
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
    semanticProposal: Schema.optional(CirceSemanticProposal),
    /**
     * Verbatim source the proposal cites. Preserved byte-for-byte (no trim)
     * so span offsets validate; when absent the host falls back to
     * `utterance`. New clients always send the untouched transcript here.
     */
    sourceUtterance: Schema.optional(CirceVerbatimUtterance),
    utterance: CirceUtterance,
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
    utterance: CirceUtterance,
    requestMetadata: Schema.optional(CirceRequestMetadata),
  }),
]);
export type CirceExecuteInput = typeof CirceExecuteInput.Type;

export const CirceNeedsInputReason = Schema.Literals([
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
export type CirceNeedsInputReason = typeof CirceNeedsInputReason.Type;

/** Partial provider/model selection carried between typed clarification steps. */
export const CirceModelDraft = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});
export type CirceModelDraft = typeof CirceModelDraft.Type;

export const CirceNeedsInput = Schema.Struct({
  status: Schema.Literal("needs-input"),
  reason: CirceNeedsInputReason,
  prompt: TrimmedNonEmptyString,
  choices: Schema.Array(TrimmedNonEmptyString),
  modelDraft: Schema.optional(CirceModelDraft),
  /**
   * Pins the exact live request this question asks about, so the next answer
   * can carry it as expectedReply even without a desk snapshot in hand.
   */
  expectedReply: Schema.optional(CirceExpectedReply),
  /** Binds the next answer to the saved frame this question belongs to. */
  clarificationFrameId: Schema.optional(TrimmedNonEmptyString),
});
export type CirceNeedsInput = typeof CirceNeedsInput.Type;

export const CirceExecutionStarted = Schema.Struct({
  status: Schema.Literal("started"),
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  objective: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  acknowledgement: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  taskRef: Schema.optional(CirceTaskRef),
  requestMetadata: Schema.optional(CirceRequestMetadata),
  /**
   * Accepted-turn correlation for speech: the turn that carries the ack
   * versus later report presentations. Populated from the actual known turn
   * id when the controller accepts; absent when no turn exists yet (new
   * tasks) or the caller predates it. Lets waiting UI match acks to reports
   * without reading wording.
   */
  turnId: Schema.optional(TurnId),
});
export type CirceExecutionStarted = typeof CirceExecutionStarted.Type;

export const CirceExecutionAcknowledged = Schema.Union([
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
    taskRef: Schema.optional(CirceTaskRef),
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
export type CirceExecutionAcknowledged = typeof CirceExecutionAcknowledged.Type;

/**
 * A pre-accept cancel won the race against semantic interpretation: the
 * awaiting execute call reports this instead of an acknowledgement, and no
 * provider work was dispatched for the request.
 */
export const CirceExecutionCancelled = Schema.Struct({
  status: Schema.Literal("cancelled"),
  requestId: TrimmedNonEmptyString,
});
export type CirceExecutionCancelled = typeof CirceExecutionCancelled.Type;

export const CirceExecutionResult = Schema.Union([
  CirceNeedsInput,
  CirceExecutionStarted,
  CirceExecutionAcknowledged,
  CirceExecutionCancelled,
]);
export type CirceExecutionResult = typeof CirceExecutionResult.Type;

/**
 * Pre-accept cancellation identity. The request id plus origin recompute the
 * exact acceptance key of the in-flight execute call; nothing else is needed
 * because cancellation never retargets accepted work.
 */
export const CirceCancelRequestInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  origin: Schema.optional(CirceOriginMetadata),
});
export type CirceCancelRequestInput = typeof CirceCancelRequestInput.Type;

/**
 * Cancelled means the semantic call was aborted before acceptance and no
 * provider work was dispatched for the request. Already-accepted means the
 * interpretation won the race: accepted work keeps running under the
 * returned identity and must be steered or stopped through its task, never
 * treated as gone. Unknown means no cancellable request is known, so the
 * caller keeps waiting for the execute receipt and reconciles via the desk.
 */
export const CirceCancelRequestResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    requestId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("already-accepted"),
    requestId: TrimmedNonEmptyString,
    threadId: Schema.optional(ThreadId),
    taskRef: Schema.optional(CirceTaskRef),
    projectId: Schema.optional(ProjectId),
  }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
    requestId: TrimmedNonEmptyString,
  }),
]);
export type CirceCancelRequestResult = typeof CirceCancelRequestResult.Type;

export const CirceTaskState = Schema.Literals([
  "running",
  "waiting-for-input",
  "waiting-for-approval",
  "ready",
  "failed",
  "interrupted",
]);
export type CirceTaskState = typeof CirceTaskState.Type;

/** Compact persisted identity. Live title, objective, lifecycle, and model data stay in T3. */
export const CirceTaskDeskTask = Schema.Struct({
  threadId: ThreadId,
  taskRef: CirceTaskRef,
  projectRef: CirceProjectRef,
});
export type CirceTaskDeskTask = typeof CirceTaskDeskTask.Type;

/** Required live view for clients; never persisted or replayed as desk state. */
export const CirceTaskDeskTaskView = Schema.Struct({
  threadId: ThreadId,
  taskRef: CirceTaskRef,
  projectRef: CirceProjectRef,
  title: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  state: CirceTaskState,
  modelSelection: ModelSelection,
  /**
   * The live pending request when exactly one waits, null when none does.
   * Absent only on payloads predating the projection; new reads always set it.
   */
  pendingReply: Schema.optional(Schema.NullOr(CirceTaskPendingReply)),
});
export type CirceTaskDeskTaskView = typeof CirceTaskDeskTaskView.Type;

export const CirceTaskClarificationFrame = Schema.Struct({
  // frameId binds an answer to the exact clarification it replies to.
  // Optional only to decode desks persisted before the identity existed;
  // new frames always carry one and answers without a match are rejected.
  frameId: Schema.optional(TrimmedNonEmptyString),
  originalUtterance: TrimmedNonEmptyString,
  contextThreadId: Schema.optional(ThreadId),
  referenceThreadId: Schema.optional(ThreadId),
  continueContext: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  requestMetadata: Schema.optional(CirceRequestMetadata),
  /** Answer pin carried across the choice so the resumed turn still verifies. */
  expectedReply: Schema.optional(Schema.NullOr(CirceExpectedReply)),
  candidates: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      taskRef: Schema.optional(CirceTaskRef),
      label: TrimmedNonEmptyString,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type CirceTaskClarificationFrame = typeof CirceTaskClarificationFrame.Type;

export const CirceProjectClarificationFrame = Schema.Struct({
  // See CirceTaskClarificationFrame.frameId: identity for exact-reply binding.
  frameId: Schema.optional(TrimmedNonEmptyString),
  originalUtterance: TrimmedNonEmptyString,
  originProjectId: ProjectId,
  originNodeId: Schema.optional(CirceNodeId),
  contextThreadId: Schema.optional(ThreadId),
  referenceThreadId: Schema.optional(ThreadId),
  continueContext: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  /** Preserve the client request identity while a project choice is pending. */
  requestMetadata: Schema.optional(CirceRequestMetadata),
  /** Answer pin carried across the choice so the resumed turn still verifies. */
  expectedReply: Schema.optional(Schema.NullOr(CirceExpectedReply)),
  candidates: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      nodeId: Schema.optional(CirceNodeId),
      label: TrimmedNonEmptyString,
      learnedAlias: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type CirceProjectClarificationFrame = typeof CirceProjectClarificationFrame.Type;

/** The one blocking interaction a session may have at a time. */
export const CircePendingInteraction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("task"),
    frame: CirceTaskClarificationFrame,
  }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    frame: CirceProjectClarificationFrame,
  }),
]);
export type CircePendingInteraction = typeof CircePendingInteraction.Type;

export const CirceProjectAliasKind = Schema.Literals(["confirmed-pronunciation", "user-defined"]);
export type CirceProjectAliasKind = typeof CirceProjectAliasKind.Type;

export const CirceProjectAlias = Schema.Struct({
  projectId: ProjectId,
  /** Local aliases are scoped by their node when projected into a mesh catalog. */
  nodeId: Schema.optional(CirceNodeId),
  alias: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  kind: CirceProjectAliasKind,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type CirceProjectAlias = typeof CirceProjectAlias.Type;

export const CirceProjectVocabularyEntry = Schema.Struct({
  projectId: ProjectId,
  nodeId: Schema.optional(CirceNodeId),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryNames: Schema.Array(TrimmedNonEmptyString),
  aliases: Schema.Array(TrimmedNonEmptyString),
  aliasDetails: Schema.Array(
    Schema.Struct({ alias: TrimmedNonEmptyString, kind: CirceProjectAliasKind }),
  ),
});
export type CirceProjectVocabularyEntry = typeof CirceProjectVocabularyEntry.Type;

export const CirceProjectVocabulary = Schema.Array(CirceProjectVocabularyEntry);
export type CirceProjectVocabulary = typeof CirceProjectVocabulary.Type;

export const CirceManageProjectAliasInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("set"),
    projectId: ProjectId,
    nodeId: Schema.optional(CirceNodeId),
    alias: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    kind: CirceProjectAliasKind,
  }),
  Schema.Struct({
    action: Schema.Literal("remove"),
    projectId: ProjectId,
    nodeId: Schema.optional(CirceNodeId),
    alias: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  }),
]);
export type CirceManageProjectAliasInput = typeof CirceManageProjectAliasInput.Type;

export const CirceManageProjectAliasResult = Schema.Struct({ changed: Schema.Boolean });
export type CirceManageProjectAliasResult = typeof CirceManageProjectAliasResult.Type;

/** Durable, session-scoped conversation context owned by Circe Host. */
export const CirceTaskDeskState = Schema.Struct({
  focusedTask: Schema.NullOr(CirceTaskDeskTask),
  recentTasks: Schema.Array(CirceTaskDeskTask),
  pendingInteraction: Schema.NullOr(CircePendingInteraction),
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type CirceTaskDeskState = typeof CirceTaskDeskState.Type;

/** Client-facing desk view derived from the current T3 projection. */
export const CirceTaskDeskView = Schema.Struct({
  focusedTask: Schema.NullOr(CirceTaskDeskTaskView),
  recentTasks: Schema.Array(CirceTaskDeskTaskView),
  pendingInteraction: Schema.NullOr(CircePendingInteraction),
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type CirceTaskDeskView = typeof CirceTaskDeskView.Type;

export const CirceFocusTaskInput = Schema.Struct({
  threadId: ThreadId,
  taskRef: CirceTaskRef,
});
export type CirceFocusTaskInput = typeof CirceFocusTaskInput.Type;

export const CirceFocusTaskResult = CirceTaskDeskView;
export type CirceFocusTaskResult = typeof CirceFocusTaskResult.Type;

/**
 * Prefix for a conversation thread's title. Conversations are ordinary T3
 * threads carrying a question; the prefix is durable product copy so any
 * client can present them as a distinct, non-task row without a generic
 * thread field.
 */
export const CIRCE_CONVERSATION_TITLE_PREFIX = "Conversation:";

/**
 * Circe keeps general-question threads in one dedicated project per node so
 * they never mix into the user's coding projects.
 */
export const CIRCE_CONVERSATIONS_PROJECT_TITLE = "Conversations";

export const CirceTaskCreatedActivityPayload = Schema.Struct({
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  messageId: Schema.optional(MessageId),
  modelSelection: Schema.optional(ModelSelection),
  reroutedFromThreadId: Schema.optional(ThreadId),
  taskRef: Schema.optional(CirceTaskRef),
  requestMetadata: Schema.optional(CirceRequestMetadata),
  /** A conversation answers a question; absent means ordinary task work. */
  flow: Schema.optional(Schema.Literals(["task", "conversation"])),
});
export type CirceTaskCreatedActivityPayload = typeof CirceTaskCreatedActivityPayload.Type;

export const CirceReviewSourceActivityPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  messageId: Schema.optional(MessageId),
  taskRef: Schema.optional(CirceTaskRef),
  requestMetadata: Schema.optional(CirceRequestMetadata),
});
export type CirceReviewSourceActivityPayload = typeof CirceReviewSourceActivityPayload.Type;

/** Latest Circe interaction that started or resumed work on an existing task. */
export const CirceTurnOriginActivityPayload = Schema.Struct({
  messageId: Schema.optional(MessageId),
  taskRef: Schema.optional(CirceTaskRef),
  requestMetadata: CirceRequestMetadata,
});
export type CirceTurnOriginActivityPayload = typeof CirceTurnOriginActivityPayload.Type;

export const CirceTurnResultFinalizedActivityPayload = Schema.Struct({
  turnId: TurnId,
  userMessageId: Schema.optional(Schema.NullOr(MessageId)),
  assistantMessageId: Schema.NullOr(MessageId),
  state: Schema.Literals(["completed", "failed", "interrupted"]),
});
export type CirceTurnResultFinalizedActivityPayload =
  typeof CirceTurnResultFinalizedActivityPayload.Type;

/** A live presentation hint derived from the authoritative T3 event stream. */
export const CircePresentationKind = Schema.Literals([
  "completed",
  "waiting-for-input",
  "approval-needed",
  "failed",
]);
export type CircePresentationKind = typeof CircePresentationKind.Type;

/**
 * Presentation is intentionally not a durable task record. The thread and its
 * pending requests remain in T3; this small DTO exists only while an origin
 * Controller is connected and subscribed to the node that owns the task.
 */
export const CircePresentationEvent = Schema.Struct({
  presentationId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  /** Execution identity for routed tasks. */
  taskRef: Schema.optional(CirceTaskRef),
  /** Only this interaction may receive the live presentation. */
  origin: CirceOriginMetadata,
  kind: CircePresentationKind,
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
export type CircePresentationEvent = typeof CircePresentationEvent.Type;

export const CircePresentationSubscriptionInput = Schema.Struct({
  originInteractionId: TrimmedNonEmptyString,
  originNodeId: Schema.optional(CirceNodeId),
});
export type CircePresentationSubscriptionInput = typeof CircePresentationSubscriptionInput.Type;

/** Expo token registration is scoped to one authenticated device on one node. */
export const CircePushToken = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:Expo|Exponent)PushToken\[[^\]]+\]$/),
);
export type CircePushToken = typeof CircePushToken.Type;

export const CircePushDeviceId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export type CircePushDeviceId = typeof CircePushDeviceId.Type;

export const CircePushRegistrationInput = Schema.Struct({
  token: CircePushToken,
  deviceId: CircePushDeviceId,
});
export type CircePushRegistrationInput = typeof CircePushRegistrationInput.Type;

export const CircePushRegistrationResult = Schema.Struct({
  registered: Schema.Boolean,
  nodeId: CirceNodeId,
});
export type CircePushRegistrationResult = typeof CircePushRegistrationResult.Type;

export class CircePushRegistrationError extends Schema.TaggedError<CircePushRegistrationError>()(
  "CircePushRegistrationError",
  { message: TrimmedNonEmptyString },
) {}

export const CircePushNotificationKind = Schema.Literals([
  "approval-required",
  "needs-input",
  "completed",
  "failed",
]);
export type CircePushNotificationKind = typeof CircePushNotificationKind.Type;

/** Best-effort push data. The durable task remains the source of truth. */
export const CircePushNotificationData = Schema.Struct({
  environmentId: CirceNodeId,
  threadId: ThreadId,
  kind: CircePushNotificationKind,
  notificationId: TrimmedNonEmptyString,
});
export type CircePushNotificationData = typeof CircePushNotificationData.Type;

export const CirceExecutionErrorCode = Schema.Literals([
  "project-not-found",
  "node-mismatch",
  "execution-unavailable",
  "request-conflict",
  "dispatch-failed",
  "internal-error",
]);
export type CirceExecutionErrorCode = typeof CirceExecutionErrorCode.Type;

export class CirceExecutionError extends Schema.TaggedError<CirceExecutionError>()(
  "CirceExecutionError",
  {
    code: CirceExecutionErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}
