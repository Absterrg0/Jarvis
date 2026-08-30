import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationReactorExtension } from "../../orchestration/Services/OrchestrationReactorExtension.ts";
import type { OrchestrationReactorExtensionShape } from "../../orchestration/Services/OrchestrationReactorExtension.ts";
import { JarvisQueueReactor } from "../Services/JarvisQueueReactor.ts";

const make = Effect.map(
  Effect.service(JarvisQueueReactor),
  (queue) => ({ start: () => queue.start() }) satisfies OrchestrationReactorExtensionShape,
);

export const JarvisOrchestrationReactorExtensionLive = Layer.effect(
  OrchestrationReactorExtension,
  make,
);
