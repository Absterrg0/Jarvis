import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface JarvisReportReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly reconcile: (event: OrchestrationEvent) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

export class JarvisReportReactor extends Context.Service<
  JarvisReportReactor,
  JarvisReportReactorShape
>()("t3/jarvis/Services/JarvisReportReactor") {}
