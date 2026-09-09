import {
  ProjectId,
  type AuthSessionId,
  type ServerSettingsError,
  type EnvironmentId,
  type JarvisCancelRequestInput,
  type JarvisCancelRequestResult,
  type JarvisExpectedReply,
  type JarvisInterpretInput,
  type JarvisRequestMetadata,
  type JarvisSemanticProposal,
  type JarvisTaskRef,
  type ModelSelection,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type {
  JarvisCommandContext,
  JarvisCommandInterpretation,
  JarvisCommandNeedsInput,
} from "@t3tools/jarvis-core/command";

export type JarvisExecutionStarted = {
  readonly status: "started";
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly objective: string;
  readonly modelSelection: ModelSelection;
  /** Validated supervisor copy for immediate spoken feedback; never dispatched as task input. */
  readonly acknowledgement?: string;
  readonly taskRef?: JarvisTaskRef;
  readonly requestMetadata?: JarvisRequestMetadata;
  /**
   * Accepted-turn correlation for speech: the turn carrying the ack when
   * known (continuations answering a pending request or steering live work).
   * Absent for brand-new tasks whose first turn has no id yet.
   */
  readonly turnId?: TurnId;
};

export type JarvisExecutionAcknowledged =
  | {
      readonly status: "acknowledged";
      readonly action: "steered" | "queued" | "interrupted" | "status";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly message: string;
    }
  | {
      readonly status: "acknowledged";
      readonly action: "focused";
      readonly projectId: ProjectId;
      readonly message: string;
    }
  | {
      readonly status: "acknowledged";
      readonly action: "projects-listed";
      readonly message: string;
    }
  | {
      readonly status: "acknowledged";
      readonly action: "conversed";
      readonly message: string;
    };

export type JarvisExecutionResult =
  | JarvisExecutionStarted
  | JarvisExecutionAcknowledged
  | JarvisCommandNeedsInput
  | { readonly status: "cancelled"; readonly requestId: string };

export interface JarvisControllerInterpreterShape {
  readonly interpret: (input: JarvisCommandContext) => Effect.Effect<JarvisCommandInterpretation>;
  /**
   * One proposal-only inference over untrusted mesh evidence. No dispatch,
   * no IDs, no acknowledgement: returns the typed proposal for client
   * grounding. The execution node revalidates before anything dispatches.
   * Optional in tests; production always provides it.
   */
  readonly propose?: (input: JarvisInterpretInput) => Effect.Effect<JarvisSemanticProposal>;
}

/**
 * The controller receives one semantic proposal and one deterministic
 * validation pass per turn. Keeping that boundary behind a small service
 * makes the model call replaceable in tests without adding mutable state.
 */
export class JarvisControllerInterpreter extends Context.Service<
  JarvisControllerInterpreter,
  JarvisControllerInterpreterShape
>()("t3/jarvis/Services/JarvisController/JarvisControllerInterpreter") {}

export class JarvisProjectNotFoundError extends Schema.TaggedErrorClass<JarvisProjectNotFoundError>()(
  "JarvisProjectNotFoundError",
  {
    projectId: ProjectId,
  },
) {}

/**
 * A request id is an idempotency key, not a reusable task name. Rejecting a
 * changed payload keeps a retry from returning a new objective for the old
 * receipt-backed task.
 */
export class JarvisRequestConflictError extends Schema.TaggedErrorClass<JarvisRequestConflictError>()(
  "JarvisRequestConflictError",
  {
    requestId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ARIS request '${this.requestId}' was already used with a different payload: ${this.detail}`;
  }
}

export type JarvisControllerError =
  | JarvisProjectNotFoundError
  | JarvisRequestConflictError
  | ProjectionRepositoryError
  | OrchestrationDispatchError
  | ServerSettingsError;

export interface JarvisControllerExecuteInput {
  /** Authenticated session whose compact task context is updated by the controller. */
  readonly sessionId: AuthSessionId;
  readonly utterance: string;
  /**
   * Verbatim source the proposal cites. When a proposal is supplied this is
   * the span authority (no trim); otherwise the host derives it from
   * `utterance` as before. Direct local callers omit both and run one local
   * interpretation.
   */
  readonly sourceUtterance?: string | undefined;
  /**
   * Nonauthoritative proposal from one interpret call. Schema-validated then
   * revalidated against the authoritative catalog, tasks, providers, and
   * pins; never authorizes beyond a regular user execute and never triggers
   * a second inference.
   */
  readonly semanticProposal?: JarvisSemanticProposal | undefined;
  readonly projectId: ProjectId;
  readonly contextThreadId?: ThreadId | undefined;
  /** Last task known to the requesting surface; used only as a control reference. */
  readonly referenceThreadId?: ThreadId | undefined;
  /** Continue the selected conversation regardless of the wording of the utterance. */
  readonly continueContext?: boolean | undefined;
  /** A saved provider/model/options selection from the controlling client. */
  readonly modelSelection?: ModelSelection | undefined;
  /** Host-confirmed real project identity used to resume a durable clarification. */
  readonly confirmedProjectId?: ProjectId | undefined;
  /**
   * Client-pinned pending request this utterance answers, verified against
   * live state. Null pins an explicit snapshot of no unique pending request.
   */
  readonly expectedReply?: JarvisExpectedReply | null | undefined;
  /** Binds an answer to the exact clarification frame it replies to. */
  readonly clarificationFrameId?: string | undefined;
  /** Internal only: transcription persisted after a real confirmation is consumed. */
  readonly confirmedProjectAlias?: string | undefined;
  /** Stable execution node supplied by the authenticated HTTP/WS boundary. */
  readonly executionNodeId?: EnvironmentId | undefined;
  /** Client request and origin metadata carried into durable task activity. */
  readonly requestMetadata?: JarvisRequestMetadata | undefined;
  /** Auth-session-scoped request key used for deterministic command IDs. */
  readonly acceptanceKey?: string | undefined;
}

export interface JarvisControllerShape {
  readonly execute: (
    input: JarvisControllerExecuteInput,
  ) => Effect.Effect<JarvisExecutionResult, JarvisControllerError>;
  /**
   * One proposal-only inference over untrusted mesh evidence. No dispatch.
   * Uses the node's ordinary configured supervisor via the ordinary provider
   * registry.
   */
  readonly interpret: (
    input: JarvisInterpretInput & {
      readonly executionNodeId?: EnvironmentId | undefined;
      readonly acceptanceKey?: string | undefined;
    },
  ) => Effect.Effect<JarvisSemanticProposal, JarvisControllerError>;
  /**
   * Project-free conversation. Answers are best-effort and not
   * receipt-backed: retries ask the model again. Carries the same
   * pre-accept identity as control calls so cancellation addresses the
   * exact tracked interpretation; untracked when absent.
   */
  readonly converse: (input: {
    readonly utterance: string;
    readonly requestMetadata?: JarvisRequestMetadata;
    readonly executionNodeId?: EnvironmentId;
    readonly acceptanceKey?: string | undefined;
  }) => Effect.Effect<JarvisExecutionResult, JarvisControllerError>;
  /**
   * Abort one pre-accept execute call by its exact request identity.
   * Cancelled means the interpretation never dispatched provider work;
   * already-accepted means interpretation won and the work runs under the
   * returned identity; unknown means nothing cancellable is known.
   */
  readonly cancelRequest: (
    input: JarvisCancelRequestInput & { readonly executionNodeId?: EnvironmentId },
  ) => Effect.Effect<JarvisCancelRequestResult, never>;
}

export class JarvisController extends Context.Service<JarvisController, JarvisControllerShape>()(
  "t3/jarvis/Services/JarvisController",
) {}
