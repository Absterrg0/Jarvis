import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { JarvisPresentationEvent } from "@t3tools/contracts";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  buildJarvisPresentation,
  isJarvisPresentationSource,
  isPresentationForOrigin,
} from "../presentation.ts";
import { JarvisPresentationFanout } from "../Services/JarvisPresentationFanout.ts";

/**
 * Overflow keeps only the newest presentations. Listeners are live voice and
 * UI surfaces; a stalled consumer must not stall or grow the shared
 * projection, and missed terminal events are reconciled against durable task
 * state instead of replayed speech.
 */
const FANOUT_CAPACITY = 256;

export const JarvisPresentationFanoutLive = Layer.effect(
  JarvisPresentationFanout,
  Effect.gen(function* () {
    const orchestration = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const hub = yield* PubSub.sliding<JarvisPresentationEvent>(FANOUT_CAPACITY);
    // Own the pump lifetime like VcsStatusBroadcaster: the fiber dies with
    // this layer instead of leaking Scope into every consumer's requirements.
    const pumpScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );

    const pump = orchestration.streamDomainEvents.pipe(
      Stream.filter(isJarvisPresentationSource),
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          if (event.type !== "thread.activity-appended" && event.type !== "thread.session-set") {
            return Option.none();
          }
          const threadId = event.payload.threadId;
          const detail = yield* projections.getThreadDetailById(threadId);
          if (Option.isNone(detail)) return Option.none();
          const project = yield* projections.getProjectShellById(detail.value.projectId);
          const presentation = buildJarvisPresentation(
            event,
            detail.value,
            Option.isSome(project) ? project.value.title : "this project",
          );
          return presentation === null ? Option.none() : Option.some(presentation);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to build Jarvis presentation", {
              aggregateId: event.aggregateId,
              cause,
            }).pipe(Effect.as(Option.none())),
          ),
        ),
      ),
      Stream.filter(Option.isSome),
      Stream.map((presentation) => presentation.value),
      Stream.runForEach((presentation) => PubSub.publish(hub, presentation)),
    );
    yield* pump.pipe(Effect.forkIn(pumpScope));

    return JarvisPresentationFanout.of({
      subscribe: (input) =>
        Stream.fromPubSub(hub).pipe(
          Stream.filter((presentation) =>
            isPresentationForOrigin(presentation, input.originInteractionId, input.originNodeId),
          ),
        ),
    });
  }),
);
