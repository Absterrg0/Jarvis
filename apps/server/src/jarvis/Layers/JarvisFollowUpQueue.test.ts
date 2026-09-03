import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ThreadId } from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { JarvisFollowUpQueue } from "../Services/JarvisFollowUpQueue.ts";
import { JarvisFollowUpQueueLive } from "./JarvisFollowUpQueue.ts";

const layer = JarvisFollowUpQueueLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("persists FIFO rows, claims once, and retains pending rows across running reset", () =>
  Effect.gen(function* () {
    const queue = yield* JarvisFollowUpQueue;
    const threadId = ThreadId.make("thread-queue");
    const input = (queueId: string, instruction: string) => ({
      queueId,
      threadId,
      instruction,
      requestMetadata: {
        requestId: `request-${queueId}`,
        origin: { originInteractionId: `interaction-${queueId}` },
      },
      enqueuedAt: "2026-08-30T00:00:00.000Z",
    });
    yield* queue.enqueue(input("queue-1", "first"));
    yield* queue.enqueue(input("queue-2", "second"));
    assert.equal(yield* queue.pendingCount(threadId), 2);
    const first = yield* queue.claimNext(threadId);
    assert.isTrue(Option.isSome(first));
    assert.equal(Option.getOrThrow(first).instruction, "first");
    assert.deepEqual(Option.getOrThrow(first).requestMetadata, {
      requestId: "request-queue-1",
      origin: { originInteractionId: "interaction-queue-1" },
    });
    assert.equal(yield* queue.pendingCount(threadId), 1);
    yield* queue.resetRunning("2026-08-30T00:01:00.000Z");
    const restarted = yield* queue.claimNext(threadId);
    assert.isTrue(Option.isSome(restarted));
    assert.equal(Option.getOrThrow(restarted).instruction, "first");
    yield* queue.markDispatched(Option.getOrThrow(restarted).queueId, "2026-08-30T00:02:00.000Z");
    const second = yield* queue.claimNext(threadId);
    assert.isTrue(Option.isSome(second));
    assert.equal(Option.getOrThrow(second).instruction, "second");
    assert.isTrue(Option.isNone(yield* queue.claimNext(threadId)));
  }).pipe(Effect.provide(layer)),
);

it.effect("cancels pending work for only the stopped thread", () =>
  Effect.gen(function* () {
    const queue = yield* JarvisFollowUpQueue;
    const stoppedThreadId = ThreadId.make("thread-stopped");
    const otherThreadId = ThreadId.make("thread-other");
    const enqueue = (queueId: string, threadId: ThreadId) =>
      queue.enqueue({
        queueId,
        threadId,
        instruction: queueId,
        enqueuedAt: "2026-08-30T00:00:00.000Z",
      });

    yield* enqueue("cancel-1", stoppedThreadId);
    yield* enqueue("cancel-2", stoppedThreadId);
    yield* enqueue("keep-1", otherThreadId);

    assert.equal(yield* queue.cancelPending(stoppedThreadId, "2026-08-30T00:01:00.000Z"), 2);
    assert.equal(yield* queue.pendingCount(stoppedThreadId), 0);
    assert.isTrue(Option.isNone(yield* queue.claimNext(stoppedThreadId)));
    assert.equal(yield* queue.pendingCount(otherThreadId), 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("cancels claimed rows so a restart cannot resurrect a stopped task", () =>
  Effect.gen(function* () {
    const queue = yield* JarvisFollowUpQueue;
    const threadId = ThreadId.make("thread-stop-race");
    yield* queue.enqueue({
      queueId: "race-1",
      threadId,
      instruction: "race-1",
      enqueuedAt: "2026-08-30T00:00:00.000Z",
    });
    yield* queue.enqueue({
      queueId: "race-2",
      threadId,
      instruction: "race-2",
      enqueuedAt: "2026-08-30T00:00:00.000Z",
    });
    assert.isTrue(Option.isSome(yield* queue.claimNext(threadId)));
    // One pending row reported; the claimed row is stopped too.
    assert.equal(yield* queue.cancelPending(threadId, "2026-08-30T00:01:00.000Z"), 1);
    yield* queue.resetRunning("2026-08-30T00:02:00.000Z");
    assert.isTrue(Option.isNone(yield* queue.claimNext(threadId)));
  }).pipe(Effect.provide(layer)),
);
