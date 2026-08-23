import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationReactorExtension } from "../../orchestration/Services/OrchestrationReactorExtension.ts";
import { JarvisQueueReactor } from "../Services/JarvisQueueReactor.ts";
import { JarvisReportReactor } from "../Services/JarvisReportReactor.ts";
import { JarvisTaskDeskReactor } from "../Services/JarvisTaskDeskReactor.ts";
import { JarvisCompletionReactor } from "../Services/JarvisCompletionReactor.ts";
import { JarvisOrchestrationReactorExtensionLive } from "./JarvisOrchestrationReactorExtension.ts";

it.effect("starts Jarvis reactors in the established order", () =>
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
      Layer.provideMerge(
        Layer.succeed(JarvisTaskDeskReactor, {
          start: () => Effect.sync(() => started.push("task-desk")).pipe(Effect.asVoid),
          reconcileThread: () => Effect.void,
          drain: Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(JarvisReportReactor, {
          start: () => Effect.sync(() => started.push("report")).pipe(Effect.asVoid),
          reconcile: () => Effect.void,
          drain: Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(JarvisCompletionReactor, {
          start: () => Effect.sync(() => started.push("completion")).pipe(Effect.asVoid),
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
    assert.deepEqual(started, ["queue", "task-desk", "report", "completion"]);
  }),
);
