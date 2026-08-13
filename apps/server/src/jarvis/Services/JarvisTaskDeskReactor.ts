import type { JarvisTaskDeskTaskState, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface JarvisTaskDeskReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly reconcileThread: (
    threadId: ThreadId,
    state: JarvisTaskDeskTaskState,
  ) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

export class JarvisTaskDeskReactor extends Context.Service<
  JarvisTaskDeskReactor,
  JarvisTaskDeskReactorShape
>()("t3/jarvis/Services/JarvisTaskDeskReactor") {}
