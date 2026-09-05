import { CommandId, EventId, MessageId, type ThreadId } from "@t3tools/contracts";
import { deriveJarvisTaskState } from "@t3tools/jarvis-core/deriveTaskState";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import { JarvisFollowUpQueue } from "../Services/JarvisFollowUpQueue.ts";

export interface JarvisFollowUpDispatcher {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly reconcileThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

/** Cross-thread bound: one slow thread must not stall every other task queue. */
const FOLLOW_UP_DISPATCH_CONCURRENCY = 4;

/**
 * Single acceptance point for queued follow-ups: claim the oldest pending row
 * for the thread and start its turn. The atomic claim decides who runs; the
 * status re-check after claim lets a stop that landed mid-claim win.
 *
 * Returns true when a turn was accepted. With retry disabled a failure returns
 * the row to pending and reports false so a later readiness event retries it.
 */
export const dispatchReadyFollowUp = Effect.fn("JarvisFollowUpDispatcher.dispatchReadyFollowUp")(
  function* (threadId: ThreadId, options: { readonly retry: boolean }) {
    const orchestration = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const queue = yield* JarvisFollowUpQueue;

    const detail = yield* projections.getThreadDetailById(threadId);
    // Readiness uses the same derived task state as the rest of Jarvis: a
    // completed turn with no live session is ready even when no session row
    // says so. Raw session status alone would strand queued work.
    if (Option.isNone(detail) || deriveJarvisTaskState(detail.value) !== "ready") return false;
    const claimed = yield* queue.claimNext(threadId);
    if (Option.isNone(claimed)) return false;

    const item = claimed.value;
    const dispatchIdentity = `jarvis:queue:dispatch:${item.queueId}`;
    const messageId = MessageId.make(`${dispatchIdentity}:message`);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const dispatchTurn = Effect.gen(function* () {
      // Re-check ownership: a stop between claim and dispatch marks the row
      // cancelled, and that stop must win. Dispatching anyway would start a
      // turn the user just stopped.
      const status = yield* queue.statusOf(item.queueId);
      if (!Option.isSome(status) || status.value !== "running") return false;
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
      return true;
    });
    const accepted = options.retry
      ? yield* dispatchTurn.pipe(
          Effect.andThen(queue.markDispatched(item.queueId, createdAt)),
          Effect.as(true),
          // Retrying reuses the same command IDs, and the engine answers
          // replays from command receipts, so a retried dispatch cannot start
          // a duplicate turn. Spaced attempts let transient failures clear
          // without a new session event; anything still failing is released
          // for a later trigger. Interruption is not a failure and propagates
          // without retrying.
          Effect.retry({
            times: 2,
            schedule: Schedule.spaced("30 seconds"),
          }),
          Effect.catchCause((cause) =>
            queue.release(item.queueId, createdAt).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        )
      : yield* dispatchTurn.pipe(
          Effect.flatMap((started) =>
            started
              ? queue.markDispatched(item.queueId, createdAt).pipe(Effect.as(true))
              : queue.release(item.queueId, createdAt).pipe(Effect.as(false)),
          ),
          Effect.catchCause((cause) =>
            queue.release(item.queueId, createdAt).pipe(Effect.andThen(Effect.succeed(false))),
          ),
          Effect.tap((started) =>
            started
              ? Effect.void
              : Effect.logWarning("Jarvis queued follow-up deferred to a later trigger", {
                  threadId,
                  queueId: item.queueId,
                }),
          ),
        );
    return accepted;
  },
);

export const makeJarvisFollowUpDispatcher = Effect.gen(function* () {
  const orchestration = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const queue = yield* JarvisFollowUpQueue;
  const ownerScope = yield* Effect.scope;
  const executionPermits = yield* Semaphore.make(FOLLOW_UP_DISPATCH_CONCURRENCY);

  // Services are captured once so per-thread workers stay dependency-free at
  // their call sites; reconcileThread keeps its plain Effect<void> shape.
  const processReady = (threadId: ThreadId) =>
    dispatchReadyFollowUp(threadId, { retry: true }).pipe(
      Effect.provideService(OrchestrationEngineService, orchestration),
      Effect.provideService(ProjectionSnapshotQuery, projections),
      Effect.provideService(JarvisFollowUpQueue, queue),
      Effect.asVoid,
    );

  // One sequential worker per thread preserves FIFO dispatch order on that
  // task while the semaphore bounds how many tasks dispatch at once, so one
  // failing thread's retry delays block only its own queue.
  const workers = new Map<ThreadId, DrainableWorker<ThreadId>>();
  const workerFor = (threadId: ThreadId): Effect.Effect<DrainableWorker<ThreadId>> =>
    Effect.gen(function* () {
      const existing = workers.get(threadId);
      if (existing !== undefined) return existing;
      const created = yield* makeDrainableWorker((id: ThreadId) =>
        executionPermits.withPermits(1)(
          processReady(id).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("Jarvis queued follow-up could not start", {
                    threadId: id,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        ),
      ).pipe(Effect.provideService(Scope.Scope, ownerScope));
      workers.set(threadId, created);
      return created;
    });
  const reconcileThread = (threadId: ThreadId): Effect.Effect<void> =>
    workerFor(threadId).pipe(
      Effect.flatMap((worker) => worker.enqueue(threadId)),
      Effect.asVoid,
    );
  const drain = Effect.suspend(() =>
    Effect.forEach([...workers.values()], (worker) => worker.drain, { discard: true }),
  );
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
    const readyThreads = yield* queue.listPendingThreadIds().pipe(
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
  return { start, reconcileThread, drain } satisfies JarvisFollowUpDispatcher;
});
