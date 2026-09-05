import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface JarvisFollowUpDispatcherShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly reconcileThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly stop: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly createdAt: string;
  }) => Effect.Effect<
    { readonly interrupted: boolean; readonly cancelledFollowUps: number },
    OrchestrationDispatchError | ProjectionRepositoryError
  >;
  readonly drain: Effect.Effect<void>;
}

export class JarvisFollowUpDispatcher extends Context.Service<
  JarvisFollowUpDispatcher,
  JarvisFollowUpDispatcherShape
>()("t3/jarvis/Services/JarvisFollowUpDispatcher") {}
