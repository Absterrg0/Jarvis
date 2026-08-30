import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { JarvisFollowUpQueue } from "../Services/JarvisFollowUpQueue.ts";
import { JarvisFollowUpQueueLive } from "./JarvisFollowUpQueue.ts";

const layer = JarvisFollowUpQueueLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("persists FIFO rows, claims once, and retains pending rows across running reset", () =>
  Effect.gen(function* () {
    const queue = yield* JarvisFollowUpQueue;
    const threadId = ThreadId.make("thread-queue");
    const projectId = ProjectId.make("project-queue");
    const input = (queueId: string, instruction: string) => ({
      queueId,
      dispatchIdentity: `jarvis:queue:dispatch:${queueId}`,
      threadId,
      projectId,
      executionNodeId: EnvironmentId.make("node-queue"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      instruction,
      enqueuedAt: "2026-08-30T00:00:00.000Z",
    });
    yield* queue.enqueue(input("queue-1", "first"));
    yield* queue.enqueue(input("queue-2", "second"));
    assert.equal(yield* queue.pendingCount(threadId), 2);
    const first = yield* queue.claimNext(threadId);
    assert.isTrue(Option.isSome(first));
    assert.equal(Option.getOrThrow(first).instruction, "first");
    assert.equal(Option.getOrThrow(first).executionNodeId, EnvironmentId.make("node-queue"));
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
