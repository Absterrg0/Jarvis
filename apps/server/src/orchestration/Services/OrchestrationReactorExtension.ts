import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface OrchestrationReactorExtensionShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class OrchestrationReactorExtension extends Context.Service<
  OrchestrationReactorExtension,
  OrchestrationReactorExtensionShape
>()("t3/orchestration/Services/OrchestrationReactorExtension") {}
