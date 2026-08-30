import {
  ProjectId,
  type AuthSessionId,
  type ServerSettingsError,
  type EnvironmentId,
  type JarvisRequestMetadata,
  type JarvisTaskRef,
  type ModelSelection,
  type ThreadId,
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
  readonly taskRef?: JarvisTaskRef;
  readonly requestMetadata?: JarvisRequestMetadata;
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
    };

export type JarvisExecutionResult =
  | JarvisExecutionStarted
  | JarvisExecutionAcknowledged
  | JarvisCommandNeedsInput;

export interface JarvisControllerInterpreterShape {
  readonly interpret: (input: JarvisCommandContext) => JarvisCommandInterpretation;
}

/**
 * The controller receives one deterministic semantic pass per turn. Keeping
 * that pass behind a small service makes the ownership boundary observable in
 * tests without adding mutable production state.
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
    return `Jarvis request '${this.requestId}' was already used with a different payload: ${this.detail}`;
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
}

export class JarvisController extends Context.Service<JarvisController, JarvisControllerShape>()(
  "t3/jarvis/Services/JarvisController",
) {}
