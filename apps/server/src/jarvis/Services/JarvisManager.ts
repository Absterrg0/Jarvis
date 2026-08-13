import { ProjectId, type ModelSelection, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { TaskIntentNeedsInput } from "../resolveTaskIntent.ts";

export type JarvisExecutionStarted = {
  readonly status: "started";
  readonly threadId: ThreadId;
  readonly objective: string;
  readonly modelSelection: ModelSelection;
};

export type JarvisExecutionResult = JarvisExecutionStarted | TaskIntentNeedsInput;

export class JarvisProjectNotFoundError extends Schema.TaggedErrorClass<JarvisProjectNotFoundError>()(
  "JarvisProjectNotFoundError",
  {
    projectId: ProjectId,
  },
) {}

export type JarvisManagerError =
  | JarvisProjectNotFoundError
  | ProjectionRepositoryError
  | OrchestrationDispatchError;

export interface JarvisManagerShape {
  readonly execute: (input: {
    readonly utterance: string;
    readonly projectId: ProjectId;
    readonly contextThreadId?: ThreadId | undefined;
    /** A companion's saved provider/model/options selection. */
    readonly modelSelection?: ModelSelection | undefined;
  }) => Effect.Effect<JarvisExecutionResult, JarvisManagerError>;
}

export class JarvisManager extends Context.Service<JarvisManager, JarvisManagerShape>()(
  "t3/jarvis/Services/JarvisManager",
) {}
