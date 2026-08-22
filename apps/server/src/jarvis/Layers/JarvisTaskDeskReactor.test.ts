// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { executeWithTaskDesk } from "../executeWithTaskDesk.ts";
import type { JarvisManagerExecuteInput } from "../Services/JarvisManager.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";
import { JarvisTaskDeskReactor } from "../Services/JarvisTaskDeskReactor.ts";
import { JarvisTaskDeskLive } from "./JarvisTaskDesk.ts";
import { JarvisTaskDeskReactorLive, taskDeskStateForEvent } from "./JarvisTaskDeskReactor.ts";

describe("JarvisTaskDeskReactor", () => {
  it.effect("reconciles blocking attention after restart and makes it the next reply target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessionId = AuthSessionId.make("session-companion");
        const focusedThreadId = ThreadId.make("thread-focused");
        const blockedThreadId = ThreadId.make("thread-blocked");
        const projectId = ProjectId.make("project-jarvis");
        const createdAt = "2026-08-14T00:00:00.000Z";
        const blockedThread: OrchestrationThread = {
          id: blockedThreadId,
          projectId,
          title: "Blocked authentication review",
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
              id: EventId.make("jarvis-created"),
              tone: "info",
              kind: "jarvis.task.created",
              summary: "Review authentication",
              payload: { objective: "Review authentication" },
              turnId: null,
              createdAt,
            },
          ],
          checkpoints: [],
          session: null,
        };
        const taskDeskLayer = JarvisTaskDeskLive.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(NodeServices.layer),
        );
        const layer = JarvisTaskDeskReactorLive.pipe(
          Layer.provideMerge(taskDeskLayer),
          Layer.provideMerge(
            Layer.mock(ProjectionSnapshotQuery)({
              getThreadDetailById: () => Effect.succeed(Option.some(blockedThread)),
              getThreadShellById: () =>
                Effect.succeed(
                  Option.some({
                    id: blockedThread.id,
                    projectId,
                    title: blockedThread.title,
                    modelSelection: blockedThread.modelSelection,
                    runtimeMode: blockedThread.runtimeMode,
                    interactionMode: blockedThread.interactionMode,
                    branch: null,
                    worktreePath: null,
                    latestTurn: null,
                    createdAt,
                    updatedAt: createdAt,
                    archivedAt: null,
                    settledOverride: null,
                    settledAt: null,
                    session: null,
                    latestUserMessageAt: null,
                    hasPendingApprovals: true,
                    hasPendingUserInput: false,
                    hasActionableProposedPlan: false,
                  }),
                ),
            }),
          ),
          Layer.provideMerge(
            Layer.mock(OrchestrationEngineService)({
              dispatch: () => Effect.die("No command is dispatched in this test"),
              readEvents: () => Stream.empty,
              streamDomainEvents: Stream.never,
              latestSequence: Effect.succeed(0),
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const taskDesk = yield* JarvisTaskDesk;
          const reactor = yield* JarvisTaskDeskReactor;
          yield* taskDesk.focus({
            sessionId,
            task: {
              threadId: focusedThreadId,
              projectId,
              title: "Primary implementation",
              objective: "Implement the primary slice",
              state: "running",
              voiceAliases: [],
            },
          });
          yield* taskDesk.focus({
            sessionId,
            task: {
              threadId: blockedThreadId,
              projectId,
              title: blockedThread.title,
              objective: "Review authentication",
              state: "running",
              voiceAliases: [],
            },
          });
          yield* taskDesk.focus({
            sessionId,
            task: {
              threadId: focusedThreadId,
              projectId,
              title: "Primary implementation",
              objective: "Implement the primary slice",
              state: "running",
              voiceAliases: [],
            },
          });

          yield* reactor.start();
          yield* reactor.drain;
          expect((yield* taskDesk.get(sessionId)).attentionThreadId).toBe(blockedThreadId);

          const received: JarvisManagerExecuteInput[] = [];
          yield* executeWithTaskDesk(
            {
              execute: (input) =>
                Effect.sync(() => {
                  received.push(input);
                  return {
                    status: "started" as const,
                    threadId: blockedThreadId,
                    objective: "Review authentication",
                    modelSelection: blockedThread.modelSelection,
                  };
                }),
            },
            taskDesk,
            sessionId,
            { utterance: "Approve it", projectId },
          );

          expect(received[0]?.referenceThreadId).toBe(blockedThreadId);
          const resumed = yield* taskDesk.get(sessionId);
          expect(resumed.attentionThreadId).toBeNull();
          expect(resumed.focusedThreadId).toBe(focusedThreadId);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it("clears resolved blockers and does not terminally fail rejected responses", () => {
    const activityEvent = (kind: string) =>
      ({
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-blocked"),
          activity: {
            id: EventId.make(`event-${kind}`),
            tone: "info",
            kind,
            summary: kind,
            payload: {},
            turnId: null,
            createdAt: "2026-08-14T00:00:00.000Z",
          },
        },
      }) as Parameters<typeof taskDeskStateForEvent>[0];

    expect(taskDeskStateForEvent(activityEvent("approval.resolved"))).toBe("running");
    expect(taskDeskStateForEvent(activityEvent("user-input.resolved"))).toBe("running");
    expect(taskDeskStateForEvent(activityEvent("provider.approval.respond.failed"))).toBeNull();
    expect(taskDeskStateForEvent(activityEvent("provider.user-input.respond.failed"))).toBeNull();
    expect(taskDeskStateForEvent(activityEvent("checkpoint.capture.failed"))).toBeNull();
    expect(taskDeskStateForEvent(activityEvent("checkpoint.revert.failed"))).toBeNull();
  });
});
