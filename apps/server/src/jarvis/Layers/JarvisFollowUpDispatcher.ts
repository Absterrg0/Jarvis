import { CommandId, EventId, MessageId, type ThreadId } from "@t3tools/contracts";
import { deriveJarvisTaskState, hasActiveJarvisTurn } from "@t3tools/jarvis-core/deriveTaskState";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import { JarvisFollowUpQueue } from "../Services/JarvisFollowUpQueue.ts";
import {
  JarvisFollowUpDispatcher,
  type JarvisFollowUpDispatcherShape,
} from "../Services/JarvisFollowUpDispatcher.ts";

const FOLLOW_UP_DISPATCH_CONCURRENCY = 4;

export const makeJarvisFollowUpDispatcher = Effect.gen(function* () {
  const orchestration = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const queue = yield* JarvisFollowUpQueue;
  const turns = yield* ProjectionTurnRepository;
  const jobs = yield* Effect.acquireRelease(TxQueue.unbounded<ThreadId>(), TxQueue.shutdown);
  const outstanding = yield* TxRef.make(0);
  const scheduled = new Set<ThreadId>();
  const dirty = new Set<ThreadId>();
  const owners = new Map<
    ThreadId,
    {
      readonly permit: Semaphore.Semaphore;
      users: number;
      stops: number;
    }
  >();

  // Stops and starts share one owner until dispatch has its engine receipt.
  // Entries exist only while a caller holds or waits for that ownership.
  const withOwner = <A, E, R>(
    threadId: ThreadId,
    stopping: boolean,
    run: (isStopping: () => boolean) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      let owner = owners.get(threadId);
      if (owner === undefined) {
        owner = { permit: Semaphore.makeUnsafe(1), users: 0, stops: 0 };
        owners.set(threadId, owner);
      }
      const entry = owner;
      entry.users += 1;
      if (stopping) entry.stops += 1;
      return entry.permit
        .withPermits(1)(run(() => entry.stops > 0))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.users -= 1;
              if (stopping) entry.stops -= 1;
              if (entry.users === 0) owners.delete(threadId);
            }),
          ),
        );
    });

  const dispatchAttempt = (threadId: ThreadId) =>
    withOwner(threadId, false, (isStopping) =>
      Effect.gen(function* () {
        if (isStopping()) return;
        const detail = yield* projections.getThreadDetailById(threadId);
        if (Option.isNone(detail)) return;
        yield* queue.reconcileAccepted(
          threadId,
          detail.value.messages.map((message) => message.id),
          DateTime.formatIso(yield* DateTime.now),
        );
        if (deriveJarvisTaskState(detail.value) !== "ready") return;
        if (Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId }))) return;
        const claimed = yield* queue.claimNext(threadId);
        if (Option.isNone(claimed)) return;
        const item = claimed.value;
        const dispatchIdentity = `jarvis:queue:dispatch:${item.queueId}`;
        const messageId = MessageId.make(`${dispatchIdentity}:message`);
        // Replayed command IDs require identical timestamps, including after restart.
        const createdAt = item.enqueuedAt;
        let accepted = false;
        yield* Effect.gen(function* () {
          if (item.requestMetadata?.origin !== undefined) {
            yield* orchestration.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(`${dispatchIdentity}:origin-command`),
              threadId,
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
          // Origin recording yields to other command producers. Check the live
          // task again before accepting queued work, and let waiting stops win.
          const current = yield* projections.getThreadDetailById(threadId);
          const pendingStart = yield* turns.getPendingTurnStartByThreadId({ threadId });
          const status = yield* queue.statusOf(item.queueId);
          if (
            isStopping() ||
            Option.isSome(pendingStart) ||
            Option.isNone(current) ||
            deriveJarvisTaskState(current.value) !== "ready" ||
            Option.isNone(status) ||
            status.value !== "running"
          )
            return;
          yield* orchestration.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(dispatchIdentity),
            threadId,
            message: { messageId, role: "user", text: item.instruction, attachments: [] },
            modelSelection: current.value.modelSelection,
            runtimeMode: current.value.runtimeMode,
            interactionMode: current.value.interactionMode,
            createdAt,
          });
          accepted = true;
          // Persistence cleanup retries independently of acceptance. Once the
          // engine has accepted the turn, bookkeeping cannot start another one.
          yield* queue.markDispatched(item.queueId, createdAt).pipe(
            Effect.retry({ times: 2 }),
            Effect.catchCause((cause) =>
              Effect.logWarning("Jarvis accepted follow-up status could not be saved", {
                threadId,
                queueId: item.queueId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              accepted ? Effect.void : queue.release(item.queueId, createdAt).pipe(Effect.orDie),
            ),
          ),
        );
      }),
    );

  const reconcileThread: JarvisFollowUpDispatcherShape["reconcileThread"] = (threadId) =>
    Effect.suspend(() => {
      if (scheduled.has(threadId)) {
        dirty.add(threadId);
        return Effect.void;
      }
      scheduled.add(threadId);
      return TxQueue.offer(jobs, threadId).pipe(
        Effect.andThen(TxRef.update(outstanding, (count) => count + 1)),
        Effect.tx,
        Effect.asVoid,
      );
    });

  const processReady = (threadId: ThreadId) =>
    dispatchAttempt(threadId).pipe(
      // Each retry releases thread ownership, so a stop can cancel during the
      // delay. Every attempt claims the oldest row again and checks readiness.
      Effect.retry({ times: 2, schedule: Schedule.spaced("1 second") }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              yield* Effect.logWarning("Jarvis queued follow-up could not start", {
                threadId,
                cause: Cause.pretty(cause),
              });
              const createdAt = DateTime.formatIso(yield* DateTime.now);
              const identity = `jarvis:queue:deferred:${threadId}:${createdAt}`;
              yield* orchestration
                .dispatch({
                  type: "thread.activity.append",
                  commandId: CommandId.make(identity),
                  threadId,
                  createdAt,
                  activity: {
                    id: EventId.make(identity),
                    tone: "error",
                    kind: "jarvis.follow-up.deferred",
                    summary:
                      "Queued follow-up could not start. It remains queued and will retry when the task becomes ready or another follow-up is queued.",
                    payload: {},
                    turnId: null,
                    createdAt,
                  },
                })
                .pipe(
                  Effect.catchCause((warningCause) =>
                    Effect.logWarning("Jarvis follow-up failure could not be recorded", {
                      threadId,
                      cause: Cause.pretty(warningCause),
                    }),
                  ),
                );
            }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          scheduled.delete(threadId);
          const again = dirty.delete(threadId);
          if (again) yield* reconcileThread(threadId);
          yield* TxRef.update(outstanding, (count) => count - 1);
        }),
      ),
    );

  // The pool is fixed-size; ready events never allocate permanent thread
  // workers. Duplicate wakeups coalesce while a thread is queued or running.
  for (let index = 0; index < FOLLOW_UP_DISPATCH_CONCURRENCY; index += 1) {
    yield* TxQueue.take(jobs).pipe(Effect.flatMap(processReady), Effect.forever, Effect.forkScoped);
  }

  const stop: JarvisFollowUpDispatcherShape["stop"] = (input) =>
    withOwner(input.threadId, true, () =>
      Effect.gen(function* () {
        const detail = yield* projections.getThreadDetailById(input.threadId);
        if (Option.isSome(detail))
          yield* queue.reconcileAccepted(
            input.threadId,
            detail.value.messages.map((message) => message.id),
            input.createdAt,
          );
        const cancelledFollowUps = yield* queue.cancelPending(input.threadId, input.createdAt);
        const pendingStart = yield* turns.getPendingTurnStartByThreadId({
          threadId: input.threadId,
        });
        const interrupted =
          Option.isSome(pendingStart) ||
          (Option.isSome(detail) && hasActiveJarvisTurn(detail.value));
        if (interrupted) yield* orchestration.dispatch({ type: "thread.turn.interrupt", ...input });
        return { interrupted, cancelledFollowUps };
      }),
    );

  const drain = TxRef.get(outstanding).pipe(
    Effect.tap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
    Effect.tx,
    Effect.asVoid,
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
    const pending = yield* queue.listPendingThreadIds().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Jarvis queue startup could not read pending work", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([])),
      ),
    );
    for (const threadId of pending) yield* reconcileThread(threadId);
  });
  return { start, reconcileThread, stop, drain } satisfies JarvisFollowUpDispatcherShape;
});

export const JarvisFollowUpDispatcherLive = Layer.effect(
  JarvisFollowUpDispatcher,
  makeJarvisFollowUpDispatcher,
);
