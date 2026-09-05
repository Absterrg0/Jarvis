import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { JarvisFollowUpQueue } from "../Services/JarvisFollowUpQueue.ts";
import { JarvisFollowUpQueueLive } from "./JarvisFollowUpQueue.ts";
import { makeJarvisFollowUpDispatcher } from "./JarvisFollowUpDispatcher.ts";

const threadId = ThreadId.make("thread-race");

const readyThread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-race"),
  title: "Race task",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:01:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId,
    status: "ready",
    providerName: "codex",
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-08-30T00:01:00.000Z",
  },
};

function harness(cancelOnClaim: boolean) {
  const commands: Array<OrchestrationCommand> = [];
  const baseQueue = JarvisFollowUpQueueLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
  const queueLayer =
    cancelOnClaim === false
      ? baseQueue
      : Layer.unwrap(
          Effect.map(Layer.build(baseQueue), (context) => {
            const queue = Context.get(context, JarvisFollowUpQueue);
            return Layer.succeed(JarvisFollowUpQueue, {
              ...queue,
              // Simulate a stop landing between claimNext and dispatch: the
              // row is cancelled while the dispatcher still holds it in memory.
              claimNext: (claimedThreadId: ThreadId) =>
                queue
                  .claimNext(claimedThreadId)
                  .pipe(
                    Effect.tap((claimed) =>
                      Option.isSome(claimed)
                        ? queue.cancelPending(claimedThreadId, "2026-08-30T00:01:00.000Z")
                        : Effect.void,
                    ),
                  ),
            });
          }),
        );
  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  });
  const projectionsLayer = Layer.mock(ProjectionSnapshotQuery)({
    getThreadDetailById: (id) =>
      Effect.succeed(id === threadId ? Option.some(readyThread) : Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getShellSnapshot: () =>
      Effect.succeed({ snapshotSequence: 1, projects: [], threads: [], updatedAt: "" }),
  });
  return {
    commands,
    layer: Layer.mergeAll(
      queueLayer,
      engineLayer,
      projectionsLayer,
      Layer.mock(ProjectionTurnRepository)({
        getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
      }),
    ),
  };
}

function runOnce(layer: ReturnType<typeof harness>["layer"]) {
  return Effect.scoped(
    Effect.gen(function* () {
      const queue = yield* JarvisFollowUpQueue;
      yield* queue.enqueue({
        queueId: "race-1",
        threadId,
        instruction: "Continue after the stop.",
        enqueuedAt: "2026-08-30T00:00:00.000Z",
      });
      const dispatcher = yield* makeJarvisFollowUpDispatcher;
      yield* dispatcher.reconcileThread(threadId);
      yield* dispatcher.drain;
    }).pipe(Effect.provide(layer)),
  );
}

describe("Jarvis follow-up dispatcher", () => {
  effectIt.effect("starts the queued turn when nothing stops it", () => {
    const layers = harness(false);
    return runOnce(layers.layer).pipe(
      Effect.map(() => {
        expect(layers.commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
      }),
    );
  });

  effectIt.effect("dispatches nothing when a stop cancels the claim mid-flight", () => {
    const layers = harness(true);
    return runOnce(layers.layer).pipe(
      Effect.map(() => {
        expect(layers.commands).toEqual([]);
      }),
    );
  });
});

const makeRaceHarness = Effect.gen(function* () {
  const queue = yield* JarvisFollowUpQueue;
  const commands: Array<OrchestrationCommand> = [];
  let current = readyThread;
  const turns = yield* ProjectionTurnRepository;
  let beforeStatusReturn: Effect.Effect<void> = Effect.void;
  let beforeDispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError> = () => Effect.void;
  const dispatcher = yield* makeJarvisFollowUpDispatcher.pipe(
    Effect.provideService(JarvisFollowUpQueue, {
      ...queue,
      statusOf: (queueId) => queue.statusOf(queueId).pipe(Effect.tap(() => beforeStatusReturn)),
    }),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () => Effect.sync(() => Option.some(current)),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.gen(function* () {
              yield* beforeDispatch(command);
              commands.push(command);
              if (command.type === "thread.turn.start") {
                yield* turns
                  .replacePendingTurnStart({
                    threadId,
                    messageId: command.message.messageId,
                    requestedAt: command.createdAt,
                    sourceProposedPlanThreadId: null,
                    sourceProposedPlanId: null,
                  })
                  .pipe(Effect.orDie);
              }
              return { sequence: commands.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
    ),
  );
  return {
    queue,
    dispatcher,
    commands,
    setCurrent: (thread: OrchestrationThread) => {
      current = thread;
    },
    setStatusHook: (effect: Effect.Effect<void>) => {
      beforeStatusReturn = effect;
    },
    setDispatchHook: (hook: typeof beforeDispatch) => {
      beforeDispatch = hook;
    },
    enqueue: (queueId: string, origin = false) =>
      queue.enqueue({
        queueId,
        threadId,
        instruction: queueId,
        ...(origin
          ? { requestMetadata: { requestId: queueId, origin: { originInteractionId: queueId } } }
          : {}),
        enqueuedAt: "2026-08-30T00:00:00.000Z",
      }),
  };
});

const stopInput = {
  threadId,
  commandId: CommandId.make("stop-race"),
  createdAt: "2026-08-30T00:01:00.000Z",
};
const raceLayer = Layer.mergeAll(JarvisFollowUpQueueLive, ProjectionTurnRepositoryLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

effectIt.effect("a stop after the status read wins before turn acceptance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeRaceHarness;
      const statusRead = yield* Deferred.make<void>();
      const continueStatus = yield* Deferred.make<void>();
      harness.setStatusHook(
        Deferred.succeed(statusRead, undefined).pipe(
          Effect.andThen(Deferred.await(continueStatus)),
        ),
      );
      yield* harness.enqueue("stop-after-status");
      yield* harness.dispatcher.reconcileThread(threadId);
      yield* Deferred.await(statusRead);
      const stopping = yield* harness.dispatcher
        .stop(stopInput)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(continueStatus, undefined);
      expect(yield* Fiber.join(stopping)).toEqual({ interrupted: false, cancelledFollowUps: 1 });
      yield* harness.dispatcher.drain;
      expect(harness.commands).toEqual([]);
      expect(yield* harness.queue.statusOf("stop-after-status")).toEqual(Option.some("cancelled"));
    }).pipe(Effect.provide(raceLayer)),
  ),
);

effectIt.effect("a stop waiting for an accepted start interrupts that turn using fresh state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeRaceHarness;
      const startEntered = yield* Deferred.make<void>();
      const acceptStart = yield* Deferred.make<void>();
      harness.setDispatchHook((command) =>
        command.type === "thread.turn.start"
          ? Deferred.succeed(startEntered, undefined).pipe(
              Effect.andThen(Deferred.await(acceptStart)),
            )
          : Effect.void,
      );
      yield* harness.enqueue("accepted-before-stop");
      yield* harness.enqueue("cancel-after-start");
      yield* harness.dispatcher.reconcileThread(threadId);
      yield* Deferred.await(startEntered);
      const stopping = yield* harness.dispatcher
        .stop(stopInput)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(acceptStart, undefined);
      expect(yield* Fiber.join(stopping)).toEqual({ interrupted: true, cancelledFollowUps: 1 });
      yield* harness.dispatcher.drain;
      expect(harness.commands.map((command) => command.type)).toEqual([
        "thread.turn.start",
        "thread.turn.interrupt",
      ]);
      expect(yield* harness.queue.statusOf("accepted-before-stop")).toEqual(
        Option.some("dispatched"),
      );
      expect(yield* harness.queue.statusOf("cancel-after-start")).toEqual(Option.some("cancelled"));
    }).pipe(Effect.provide(raceLayer)),
  ),
);

effectIt.effect("rechecks readiness after origin recording and retains the oldest follow-up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeRaceHarness;
      harness.setDispatchHook((command) =>
        Effect.sync(() => {
          if (command.type === "thread.activity.append") {
            harness.setCurrent({
              ...readyThread,
              session: { ...readyThread.session!, status: "running" },
            });
          }
        }),
      );
      yield* harness.enqueue("origin-first", true);
      yield* harness.enqueue("origin-second");
      yield* harness.dispatcher.reconcileThread(threadId);
      yield* harness.dispatcher.drain;
      expect(harness.commands.map((command) => command.type)).toEqual(["thread.activity.append"]);
      expect(yield* harness.queue.pendingCount(threadId)).toBe(2);
      harness.setDispatchHook(() => Effect.void);
      harness.setCurrent(readyThread);
      yield* harness.dispatcher.reconcileThread(threadId);
      yield* harness.dispatcher.drain;
      expect(harness.commands.at(-1)).toMatchObject({
        type: "thread.turn.start",
        message: { text: "origin-first" },
      });
      expect(yield* harness.queue.statusOf("origin-second")).toEqual(Option.some("pending"));
    }).pipe(Effect.provide(raceLayer)),
  ),
);

effectIt.effect(
  "retries transient dispatch failures without another readiness event and preserves FIFO",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeRaceHarness;
        const failed = yield* Deferred.make<void>();
        let attempts = 0;
        const origins: Array<OrchestrationCommand> = [];
        harness.setDispatchHook((command) =>
          Effect.gen(function* () {
            if (command.type === "thread.activity.append") origins.push(command);
            if (command.type !== "thread.turn.start") return;
            attempts += 1;
            if (attempts === 1) {
              yield* Deferred.succeed(failed, undefined);
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "transient test failure",
              });
            }
          }),
        );
        yield* harness.enqueue("retry-first", true);
        yield* harness.enqueue("retry-second");
        yield* harness.dispatcher.reconcileThread(threadId);
        yield* Deferred.await(failed);
        yield* TestClock.adjust("1 second");
        yield* harness.dispatcher.drain;
        expect(attempts).toBe(2);
        expect(origins).toHaveLength(2);
        expect(origins[1]).toEqual(origins[0]);
        expect(
          harness.commands.filter((command) => command.type === "thread.turn.start"),
        ).toHaveLength(1);
        expect(harness.commands.at(-1)).toMatchObject({
          type: "thread.turn.start",
          message: { text: "retry-first" },
        });
        expect(yield* harness.queue.statusOf("retry-first")).toEqual(Option.some("dispatched"));
        expect(yield* harness.queue.statusOf("retry-second")).toEqual(Option.some("pending"));
      }).pipe(Effect.provide(raceLayer)),
    ),
);

effectIt.effect("coalesces simultaneous wakeups without starting the next queued row", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeRaceHarness;
      const startEntered = yield* Deferred.make<void>();
      const acceptStart = yield* Deferred.make<void>();
      harness.setDispatchHook((command) =>
        command.type === "thread.turn.start"
          ? Deferred.succeed(startEntered, undefined).pipe(
              Effect.andThen(Deferred.await(acceptStart)),
            )
          : Effect.void,
      );
      yield* harness.enqueue("simultaneous-first");
      yield* harness.enqueue("simultaneous-second");
      yield* harness.dispatcher.reconcileThread(threadId);
      yield* Deferred.await(startEntered);
      yield* Effect.forEach(
        Array.from({ length: 20 }),
        () => harness.dispatcher.reconcileThread(threadId),
        { concurrency: "unbounded" },
      );
      yield* Deferred.succeed(acceptStart, undefined);
      yield* harness.dispatcher.drain;
      expect(harness.commands).toHaveLength(1);
      expect(yield* harness.queue.statusOf("simultaneous-second")).toEqual(Option.some("pending"));
    }).pipe(Effect.provide(raceLayer)),
  ),
);
