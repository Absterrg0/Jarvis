import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { JarvisQueueReactor } from "../Services/JarvisQueueReactor.ts";
import { JarvisPendingFollowUpQuery } from "../Services/JarvisPendingFollowUpQuery.ts";
import { JarvisQueueReactorLive, nextQueuedFollowUp } from "./JarvisQueueReactor.ts";

describe("nextQueuedFollowUp", () => {
  it("selects queued work in order and skips work already dispatched", () => {
    const base = {
      tone: "info" as const,
      turnId: null,
      createdAt: "2026-08-13T00:00:00.000Z",
    };
    expect(
      nextQueuedFollowUp([
        {
          ...base,
          id: EventId.make("queue-1"),
          kind: "jarvis.followup.queued",
          summary: "first",
          payload: {},
        },
        {
          ...base,
          id: EventId.make("queue-2"),
          kind: "jarvis.followup.queued",
          summary: "second",
          payload: {},
        },
        {
          ...base,
          id: EventId.make("done-1"),
          kind: "jarvis.followup.dispatched",
          summary: "first",
          payload: { queueId: "queue-1" },
        },
      ]),
    ).toEqual({ id: "queue-2", instruction: "second" });
  });

  it.effect("dispatches queued work after the exact thread becomes ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-1");
        const createdAt = "2026-08-13T00:00:00.000Z";
        const commands: Array<OrchestrationCommand> = [];
        const activityBase = {
          tone: "info" as const,
          turnId: null,
          createdAt,
        };
        let thread: OrchestrationThread = {
          id: threadId,
          projectId: ProjectId.make("project-1"),
          title: "Build Director",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [
            {
              id: EventId.make("queue-1"),
              tone: "info",
              kind: "jarvis.followup.queued",
              summary: "update the docs",
              payload: {},
              turnId: null,
              createdAt,
            },
          ],
          checkpoints: [],
          session: {
            threadId,
            status: "ready",
            providerName: "Codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
        };
        const layer = JarvisQueueReactorLive.pipe(
          Layer.provideMerge(
            Layer.mock(ProjectionSnapshotQuery)({
              getThreadDetailById: () => Effect.succeed(Option.some(thread)),
            }),
          ),
          Layer.provideMerge(
            Layer.mock(JarvisPendingFollowUpQuery)({
              listReadyThreads: () => Effect.succeed([threadId]),
            }),
          ),
          Layer.provideMerge(
            Layer.mock(OrchestrationEngineService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: commands.length };
                }),
              readEvents: () => Stream.empty,
              streamDomainEvents: Stream.never,
              latestSequence: Effect.succeed(0),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const reactor = yield* JarvisQueueReactor;
          thread = { ...thread, session: { ...thread.session!, status: "running" } };
          yield* reactor.reconcileThread(threadId);
          yield* reactor.drain;
          expect(commands).toEqual([]);
          thread = { ...thread, session: { ...thread.session!, status: "ready" } };
          yield* reactor.start();
          yield* reactor.drain;

          thread = {
            ...thread,
            session: { ...thread.session!, status: "ready" },
            activities: [
              ...thread.activities,
              {
                ...activityBase,
                id: EventId.make("replacement-request"),
                kind: "jarvis.task.replacement.requested",
                summary: "Provider replacement requested",
                payload: { requestId: "stop-command-1" },
              },
              {
                ...activityBase,
                id: EventId.make("replacement-stopped"),
                kind: "provider.session.stop.succeeded",
                summary: "Provider session stopped",
                payload: { requestId: "stop-command-1" },
              },
            ],
          };
          yield* reactor.reconcileThread(threadId);
          yield* reactor.drain;
          expect(commands).toHaveLength(2);
        }).pipe(Effect.provide(layer));
        expect(commands.map((command) => command.type)).toEqual([
          "thread.turn.start",
          "thread.activity.append",
        ]);
        expect(commands[0]).toMatchObject({
          type: "thread.turn.start",
          threadId,
          message: { text: "update the docs" },
        });
      }),
    ),
  );
});
