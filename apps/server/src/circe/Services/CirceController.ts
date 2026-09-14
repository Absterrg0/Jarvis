import {
  ProjectId,
  type AuthSessionId,
  type ServerSettingsError,
  type EnvironmentId,
  type CirceCancelRequestInput,
  type CirceCancelRequestResult,
  type CirceExpectedReply,
  type CirceInterpretInput,
  type CirceRequestMetadata,
  type CirceSemanticProposal,
  type CirceTaskRef,
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
  CirceCommandContext,
  CirceCommandInterpretation,
  CirceCommandNeedsInput,
} from "@circe/core/command";

export type CirceExecutionStarted = {
  readonly status: "started";
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly objective: string;
  readonly modelSelection: ModelSelection;
  /** Validated supervisor copy for immediate spoken feedback; never dispatched as task input. */
  readonly acknowledgement?: string;
  readonly taskRef?: CirceTaskRef;
  readonly requestMetadata?: CirceRequestMetadata;
  /**
   * Accepted-turn correlation for speech: the turn carrying the ack when
   * known (continuations answering a pending request or steering live work).
   * Absent for brand-new tasks whose first turn has no id yet.
   */
  readonly turnId?: TurnId;
};

export type CirceExecutionAcknowledged =
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

/** One validated, executed step of a multi-command turn. */
export type CirceExecutionPlanStep = {
  readonly action: string;
  readonly status: "started" | "acknowledged" | "needs-input" | "failed";
  readonly message: string;
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
};

/**
 * A multi-command turn. Every step was validated before the first dispatch,
 * so this reports an ordered, already-decided plan; a step that needed input
 * stops the plan there. Structurally matches the wire contract.
 */
export type CirceExecutionPlan = {
  readonly status: "plan";
  readonly message: string;
  readonly steps: ReadonlyArray<CirceExecutionPlanStep>;
};

export type CirceExecutionResult =
  | CirceExecutionStarted
  | CirceExecutionAcknowledged
  | CirceExecutionPlan
  | CirceCommandNeedsInput
  | { readonly status: "cancelled"; readonly requestId: string };

export interface CirceControllerInterpreterShape {
  readonly interpret: (input: CirceCommandContext) => Effect.Effect<CirceCommandInterpretation>;
  /**
   * One proposal-only inference over untrusted mesh evidence. No dispatch,
   * no IDs, no acknowledgement: returns the typed proposal for client
   * grounding. The execution node revalidates before anything dispatches.
   * Optional in tests; production always provides it.
   */
  readonly propose?: (input: CirceInterpretInput) => Effect.Effect<CirceSemanticProposal>;
}

/**
 * The controller receives one semantic proposal and one deterministic
 * validation pass per turn. Keeping that boundary behind a small service
 * makes the model call replaceable in tests without adding mutable state.
 */
export class CirceControllerInterpreter extends Context.Service<
  CirceControllerInterpreter,
  CirceControllerInterpreterShape
>()("@absterrg0/circe/circe/Services/CirceController/CirceControllerInterpreter") {}

export class CirceProjectNotFoundError extends Schema.TaggedError<CirceProjectNotFoundError>()(
  "CirceProjectNotFoundError",
  {
    projectId: ProjectId,
  },
) {}

/**
 * A request id is an idempotency key, not a reusable task name. Rejecting a
 * changed payload keeps a retry from returning a new objective for the old
 * receipt-backed task.
 */
export class CirceRequestConflictError extends Schema.TaggedError<CirceRequestConflictError>()(
  "CirceRequestConflictError",
  {
    requestId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Circe request '${this.requestId}' was already used with a different payload: ${this.detail}`;
  }
}

export type CirceControllerError =
  | CirceProjectNotFoundError
  | CirceRequestConflictError
  | ProjectionRepositoryError
  | OrchestrationDispatchError
  | ServerSettingsError;

export interface CirceControllerExecuteInput {
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
  readonly semanticProposal?: CirceSemanticProposal | undefined;
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
  readonly expectedReply?: CirceExpectedReply | null | undefined;
  /** Binds an answer to the exact clarification frame it replies to. */
  readonly clarificationFrameId?: string | undefined;
  /** Internal only: transcription persisted after a real confirmation is consumed. */
  readonly confirmedProjectAlias?: string | undefined;
  /** Stable execution node supplied by the authenticated HTTP/WS boundary. */
  readonly executionNodeId?: EnvironmentId | undefined;
  /** Client request and origin metadata carried into durable task activity. */
  readonly requestMetadata?: CirceRequestMetadata | undefined;
  /** Auth-session-scoped request key used for deterministic command IDs. */
  readonly acceptanceKey?: string | undefined;
}

export interface CirceControllerShape {
  readonly execute: (
    input: CirceControllerExecuteInput,
  ) => Effect.Effect<CirceExecutionResult, CirceControllerError>;
  /**
   * One proposal-only inference over untrusted mesh evidence. No dispatch.
   * Uses the node's ordinary configured supervisor via the ordinary provider
   * registry.
   */
  readonly interpret: (
    input: CirceInterpretInput & {
      readonly executionNodeId?: EnvironmentId | undefined;
      readonly acceptanceKey?: string | undefined;
    },
  ) => Effect.Effect<CirceSemanticProposal, CirceControllerError>;
  /**
   * Project-free conversation. Answers are best-effort and not
   * receipt-backed: retries ask the model again. Carries the same
   * pre-accept identity as control calls so cancellation addresses the
   * exact tracked interpretation; untracked when absent.
   */
  readonly converse: (input: {
    readonly utterance: string;
    readonly requestMetadata?: CirceRequestMetadata;
    readonly executionNodeId?: EnvironmentId;
    readonly acceptanceKey?: string | undefined;
  }) => Effect.Effect<CirceExecutionResult, CirceControllerError>;
  /**
   * Abort one pre-accept execute call by its exact request identity.
   * Cancelled means the interpretation never dispatched provider work;
   * already-accepted means interpretation won and the work runs under the
   * returned identity; unknown means nothing cancellable is known.
   */
  readonly cancelRequest: (
    input: CirceCancelRequestInput & { readonly executionNodeId?: EnvironmentId },
  ) => Effect.Effect<CirceCancelRequestResult, never>;
}

export class CirceController extends Context.Service<CirceController, CirceControllerShape>()(
  "@absterrg0/circe/circe/Services/CirceController",
) {}
