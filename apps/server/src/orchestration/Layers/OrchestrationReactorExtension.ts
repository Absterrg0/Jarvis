import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationReactorExtension } from "../Services/OrchestrationReactorExtension.ts";

/** Standalone T3 has no product-specific reactor extension. */
export const OrchestrationReactorExtensionNoopLive = Layer.succeed(OrchestrationReactorExtension, {
  start: () => Effect.void,
});
