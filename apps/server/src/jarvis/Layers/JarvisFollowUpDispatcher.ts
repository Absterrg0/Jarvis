import { CommandId, EventId, MessageId, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import { JarvisFollowUpQueue } from "../Services/JarvisFollowUpQueue.ts";

export interface JarvisFollowUpDispatcher {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly reconcileThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

export const makeJarvisFollowUpDispatcher = Effect.gen(function* () {
  const orchestration = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const queue = yield* JarvisFollowUpQueue;

  const processReady = Effect.fn("JarvisFollowUpDispatcher.processReady")(function* (
    threadId: ThreadId,
  ) {
    const detail = yield* projections.getThreadDetailById(threadId);
    if (Option.isNone(detail) || detail.value.session?.status !== "ready") return;
    const claimed = yield* queue.claimNext(threadId);
    if (Option.isNone(claimed)) return;

    const item = claimed.value;
    const dispatchIdentity = `jarvis:queue:dispatch:${item.queueId}`;
    const messageId = MessageId.make(`${dispatchIdentity}:message`);
    const createdAt = detail.value.session.updatedAt ?? DateTime.formatIso(yield* DateTime.now);
    const dispatchTurn = Effect.gen(function* () {
      if (item.requestMetadata?.origin !== undefined) {
        yield* orchestration.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`${dispatchIdentity}:origin-command`),
          threadId: item.threadId,
          activity: {
            id: EventId.make(`${dispatchIdentity}:origin-activity`),
            tone: "info",
            kind: "jarvis.turn.origin",
            summary: "Continued by Jarvis",
            payload: { messageId, requestMetadata: item.requestMetadata },
            turnId: null,
            createdAt,
          },
          createdAt,
        });
      }
      yield* orchestration.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(dispatchIdentity),
        threadId: item.threadId,
        message: {
          messageId,
          role: "user",
          text: item.instruction,
          attachments: [],
        },
        modelSelection: detail.value.modelSelection,
        runtimeMode: detail.value.runtimeMode,
        interactionMode: detail.value.interactionMode,
        createdAt,
      });
    });
    yield* dispatchTurn.pipe(
      Effect.andThen(queue.markDispatched(item.queueId, createdAt)),
      Effect.catchCause((cause) =>
        queue.release(item.queueId, createdAt).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );
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
  const reconcileThread = (threadId: ThreadId): Effect.Effect<void> => worker.enqueue(threadId);
  const start = Effect.fn("JarvisFollowUpDispatcher.start")(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* queue.resetRunning(now).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Jarvis queue startup could not reset claimed work", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* forkParked(
      Stream.runForEach(orchestration.streamDomainEvents, (event) =>
        (event.type === "thread.session-set" && event.payload.session.status === "ready") ||
        (event.type === "thread.activity-appended" &&
          event.payload.activity.kind === "provider.session.stop.failed")
          ? reconcileThread(event.payload.threadId)
          : Effect.void,
      ),
    );
    const readyThreads = yield* queue.listReadyThreadIds().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Jarvis queue startup could not read pending work", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
    if (readyThreads !== undefined) {
      for (const readyThreadId of readyThreads) yield* reconcileThread(readyThreadId);
    }
  });
  return { start, reconcileThread, drain: worker.drain } satisfies JarvisFollowUpDispatcher;
});
