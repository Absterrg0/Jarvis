import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationReactorExtension } from "../../orchestration/Services/OrchestrationReactorExtension.ts";
import type { OrchestrationReactorExtensionShape } from "../../orchestration/Services/OrchestrationReactorExtension.ts";
import { JarvisQueueReactor } from "../Services/JarvisQueueReactor.ts";
import { JarvisReportReactor } from "../Services/JarvisReportReactor.ts";
import { JarvisTaskDeskReactor } from "../Services/JarvisTaskDeskReactor.ts";

const make = Effect.gen(function* () {
  const queue = yield* JarvisQueueReactor;
  const taskDesk = yield* JarvisTaskDeskReactor;
  const report = yield* JarvisReportReactor;

  return {
    start: () =>
      Effect.gen(function* () {
        yield* queue.start();
        yield* taskDesk.start();
        yield* report.start();
      }),
  } satisfies OrchestrationReactorExtensionShape;
});

export const JarvisOrchestrationReactorExtensionLive = Layer.effect(
  OrchestrationReactorExtension,
  make,
);
