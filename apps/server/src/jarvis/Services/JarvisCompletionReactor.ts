import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface JarvisCompletionReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class JarvisCompletionReactor extends Context.Service<
  JarvisCompletionReactor,
  JarvisCompletionReactorShape
>()("t3/jarvis/Services/JarvisCompletionReactor") {}
