import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  JarvisQueueReactor,
  type JarvisQueueReactorShape,
} from "../Services/JarvisQueueReactor.ts";
import { JarvisPendingFollowUpQuery } from "../Services/JarvisPendingFollowUpQuery.ts";

export function nextQueuedFollowUp(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): { readonly id: string; readonly instruction: string } | undefined {
  const dispatched = new Set(
    activities
      .filter((activity) => activity.kind === "jarvis.followup.dispatched")
      .flatMap((activity) => {
        const payload = activity.payload;
        return typeof payload === "object" &&
          payload !== null &&
          "queueId" in payload &&
          typeof payload.queueId === "string"
          ? [payload.queueId]
          : [];
      }),
  );
  return activities
    .filter((activity) => activity.kind === "jarvis.followup.queued")
    .map((activity) => ({ id: activity.id, instruction: activity.summary }))
    .find((queued) => !dispatched.has(queued.id));
}

const make = Effect.gen(function* () {
  const orchestration = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const pendingFollowUps = yield* JarvisPendingFollowUpQuery;

  const processReady = Effect.fn("JarvisQueueReactor.processReady")(function* (threadId: ThreadId) {
    const detail = yield* projections.getThreadDetailById(threadId);
    if (Option.isNone(detail)) return;
    if (detail.value.session?.status !== "ready") return;
    const queued = nextQueuedFollowUp(detail.value.activities);
    if (queued === undefined) return;
    const createdAt = detail.value.session?.updatedAt ?? DateTime.formatIso(yield* DateTime.now);
    yield* orchestration.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`jarvis:queue:start:${queued.id}`),
      threadId,
      message: {
        messageId: MessageId.make(`jarvis:queue:message:${queued.id}`),
        role: "user",
        text: queued.instruction,
        attachments: [],
      },
      modelSelection: detail.value.modelSelection,
      runtimeMode: detail.value.runtimeMode,
      interactionMode: detail.value.interactionMode,
      createdAt,
    });
    yield* orchestration.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`jarvis:queue:mark:${queued.id}`),
      threadId,
      activity: {
        id: EventId.make(`jarvis:queue:dispatched:${queued.id}`),
        tone: "info",
        kind: "jarvis.followup.dispatched",
        summary: queued.instruction,
        payload: { queueId: queued.id },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    processReady(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Jarvis queued follow-up could not start", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  const reconcileThread: JarvisQueueReactorShape["reconcileThread"] = (threadId) =>
    worker.enqueue(threadId);
  const start: JarvisQueueReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestration.streamDomainEvents, (event) =>
        (event.type === "thread.session-set" && event.payload.session.status === "ready") ||
        (event.type === "thread.activity-appended" &&
          event.payload.activity.kind === "jarvis.followup.queued")
          ? reconcileThread(event.payload.threadId)
          : Effect.void,
      ),
    );
    const readyThreads = yield* pendingFollowUps.listReadyThreads().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Jarvis queue startup reconciliation could not read tasks", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
    if (readyThreads !== undefined) {
      for (const threadId of readyThreads) yield* reconcileThread(threadId);
    }
  });
  return { start, reconcileThread, drain: worker.drain } satisfies JarvisQueueReactorShape;
});

export const JarvisQueueReactorLive = Layer.effect(JarvisQueueReactor, make);
