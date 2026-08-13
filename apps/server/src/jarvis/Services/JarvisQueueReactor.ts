import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { ThreadId } from "@t3tools/contracts";

export interface JarvisQueueReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly reconcileThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

export class JarvisQueueReactor extends Context.Service<
  JarvisQueueReactor,
  JarvisQueueReactorShape
>()("t3/jarvis/Services/JarvisQueueReactor") {}
