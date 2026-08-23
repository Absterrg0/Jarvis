import {
  ProjectId,
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
import type { TaskIntentNeedsInput } from "@t3tools/jarvis-core/resolveTaskIntent";

export type JarvisExecutionStarted = {
  readonly status: "started";
  readonly threadId: ThreadId;
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
  | TaskIntentNeedsInput;

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

export type JarvisManagerError =
  | JarvisProjectNotFoundError
  | JarvisRequestConflictError
  | ProjectionRepositoryError
  | OrchestrationDispatchError;

export interface JarvisManagerExecuteInput {
  readonly utterance: string;
  readonly projectId: ProjectId;
  readonly contextThreadId?: ThreadId | undefined;
  /** Last task known to the requesting surface; used only as a control reference. */
  readonly referenceThreadId?: ThreadId | undefined;
  /** Continue the selected conversation regardless of the wording of the utterance. */
  readonly continueContext?: boolean | undefined;
  /** A companion's saved provider/model/options selection. */
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

export interface JarvisManagerShape {
  readonly execute: (
    input: JarvisManagerExecuteInput,
  ) => Effect.Effect<JarvisExecutionResult, JarvisManagerError>;
}

export class JarvisManager extends Context.Service<JarvisManager, JarvisManagerShape>()(
  "t3/jarvis/Services/JarvisManager",
) {}
