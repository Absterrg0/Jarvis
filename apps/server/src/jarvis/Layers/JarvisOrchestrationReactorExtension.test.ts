import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationReactorExtension } from "../../orchestration/Services/OrchestrationReactorExtension.ts";
import { JarvisQueueReactor } from "../Services/JarvisQueueReactor.ts";
import { JarvisOrchestrationReactorExtensionLive } from "./JarvisOrchestrationReactorExtension.ts";

it.effect("starts the Jarvis queue reactor", () =>
  Effect.gen(function* () {
    const started: Array<string> = [];
    const layer = JarvisOrchestrationReactorExtensionLive.pipe(
      Layer.provideMerge(
        Layer.succeed(JarvisQueueReactor, {
          start: () => Effect.sync(() => started.push("queue")).pipe(Effect.asVoid),
          reconcileThread: () => Effect.void,
          drain: Effect.void,
        }),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const extension = yield* Effect.service(OrchestrationReactorExtension);
        yield* extension.start();
      }).pipe(Effect.provide(layer)),
    );
    assert.deepEqual(started, ["queue"]);
  }),
);
