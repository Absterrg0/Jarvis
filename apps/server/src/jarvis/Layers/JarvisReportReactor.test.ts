import {
  EventId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type JarvisVoiceReport,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { JarvisReportOutbox } from "../Services/JarvisReportOutbox.ts";
import { JarvisReportReactor } from "../Services/JarvisReportReactor.ts";
import { attentionClosureForActivity, JarvisReportReactorLive } from "./JarvisReportReactor.ts";

it("closes obsolete blocker attention when a provider rejects a stale response", () => {
  assert.deepEqual(
    attentionClosureForActivity({
      id: EventId.make("activity-stale-response"),
      tone: "error",
      kind: "provider.user-input.respond.failed",
      summary: "Response failed",
      payload: {
        requestId: "request-stale",
        message: "Unknown pending user-input request request-stale",
      },
      turnId: null,
      createdAt: "2026-08-14T00:00:00.000Z",
    }),
    {
      requestId: "request-stale",
      kind: "waiting-for-input",
      terminalFailure: true,
    },
  );
});

it.effect(
  "replays a remote completion with its TaskRef and origin into the outbox without a report subscriber",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-replayed-report");
        const projectId = ProjectId.make("project-replayed-report");
        const turnId = TurnId.make("turn-replayed-report");
        const messageId = MessageId.make("message-replayed-report");
        const createdAt = "2026-08-14T00:00:00.000Z";
        const completion = {
          sequence: 41,
          eventId: EventId.make("event-replayed-completion"),
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.activity-appended",
          occurredAt: createdAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-replayed-completion"),
              tone: "info",
              kind: "jarvis.turn.completion-ready",
              summary: "Jarvis completion ready",
              payload: { turnId, assistantMessageId: messageId, state: "completed" },
              turnId,
              createdAt,
            },
          },
          metadata: {},
        } satisfies OrchestrationEvent;
        const thread: OrchestrationThread = {
          id: threadId,
          projectId,
          title: "Replayed Jarvis task",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
          runtimeMode: "full-access",
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
          messages: [
            {
              id: messageId,
              role: "assistant",
              text: "The disconnected task completed successfully.",
              turnId,
              streaming: false,
              createdAt,
              updatedAt: createdAt,
            },
          ],
          proposedPlans: [],
          activities: [
            {
              id: EventId.make("activity-jarvis-created"),
              tone: "info",
              kind: "jarvis.task.created",
              summary: "Started by Jarvis",
              payload: {
                objective: "Complete work while the client is away.",
                taskRef: {
                  executionNodeId: EnvironmentId.make("environment-desktop"),
                  remoteTaskId: "remote-task-1",
                  remoteThreadId: threadId,
                  projectId,
                  providerId: ProviderInstanceId.make("codex"),
                },
                requestMetadata: {
                  requestId: "request-companion-1",
                  origin: {
                    originNodeId: EnvironmentId.make("companion-origin:installation-1"),
                    originInteractionId: "installation-1",
                  },
                },
              },
              turnId: null,
              createdAt,
            },
          ],
          checkpoints: [],
          session: null,
        };
        const appended: Array<{ sourceSequence: number; report: JarvisVoiceReport }> = [];
        let projectedThrough = 0;
        const layer = JarvisReportReactorLive.pipe(
          Layer.provideMerge(
            Layer.mock(OrchestrationEngineService)({
              dispatch: () => Effect.die("No command is dispatched in this test"),
              readEvents: (afterSequence) => {
                assert.equal(afterSequence, 0);
                return Stream.make(completion);
              },
              streamDomainEvents: Stream.never,
              latestSequence: Effect.succeed(41),
            }),
          ),
          Layer.provideMerge(
            Layer.mock(ProjectionSnapshotQuery)({
              getThreadDetailById: () => Effect.succeed(Option.some(thread)),
              getProjectShellById: () => Effect.succeed(Option.none()),
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(
              JarvisReportOutbox,
              JarvisReportOutbox.of({
                register: () => Effect.void,
                append: (input) =>
                  Effect.sync(() => {
                    appended.push(input);
                    return true;
                  }),
                dismissAttention: () => Effect.void,
                advanceSourceSequence: (sourceSequence) =>
                  Effect.sync(() => {
                    projectedThrough = sourceSequence;
                  }),
                latestSourceSequence: Effect.succeed(0),
                claimSpeech: () => Effect.succeed("missing"),
                confirmSpeech: () => Effect.succeed("missing"),
                acknowledge: (_sessionId, throughSequence) => Effect.succeed(throughSequence),
                subscribe: () => Stream.empty,
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const reactor = yield* JarvisReportReactor;
          yield* reactor.start();
          yield* reactor.drain;
        }).pipe(Effect.provide(layer));

        assert.equal(appended.length, 1);
        assert.equal(appended[0]?.sourceSequence, 41);
        assert.equal(appended[0]?.report.reportId, messageId);
        assert.deepEqual(appended[0]?.report.taskRef, {
          executionNodeId: EnvironmentId.make("environment-desktop"),
          remoteTaskId: "remote-task-1",
          remoteThreadId: threadId,
          projectId,
          providerId: ProviderInstanceId.make("codex"),
        });
        assert.deepEqual(appended[0]?.report.origin, {
          originNodeId: EnvironmentId.make("companion-origin:installation-1"),
          originInteractionId: "installation-1",
        });
        assert.equal(projectedThrough, 41);
      }),
    ),
);
