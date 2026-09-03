import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

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
  return { commands, queueLayer, engineLayer, projectionsLayer };
}

function runOnce(layers: ReturnType<typeof harness>) {
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
    }).pipe(
      Effect.provide(layers.queueLayer),
      Effect.provide(layers.engineLayer),
      Effect.provide(layers.projectionsLayer),
    ),
  );
}

describe("Jarvis follow-up dispatcher", () => {
  it("starts the queued turn when nothing stops it", async () => {
    const layers = harness(false);
    await Effect.runPromise(runOnce(layers));
    expect(layers.commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
  });

  it("dispatches nothing when a stop cancels the claim mid-flight", async () => {
    const layers = harness(true);
    await Effect.runPromise(runOnce(layers));
    expect(layers.commands).toEqual([]);
  });
});
