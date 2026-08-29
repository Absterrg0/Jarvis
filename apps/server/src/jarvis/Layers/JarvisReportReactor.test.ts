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
                stageWorkStartedCandidate: () => Effect.succeed(false),
                promoteWorkStartedCandidate: () => Effect.succeed(false),
                dismissWorkStartedCandidate: () => Effect.void,
                dismissAttention: () => Effect.void,
                advanceSourceSequence: (sourceSequence) =>
                  Effect.sync(() => {
                    projectedThrough = sourceSequence;
                  }),
                latestSourceSequence: Effect.succeed(0),
                claimSpeech: () => Effect.succeed("missing"),
                confirmSpeech: () => Effect.succeed("missing"),
                releaseSpeech: () => Effect.succeed("missing"),
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

const makeManagedThread = (
  threadId: ThreadId,
  projectId: ProjectId,
  turnId: TurnId,
  messageId: MessageId,
): OrchestrationThread => ({
  id: threadId,
  projectId,
  title: "Managed task",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [
    {
      id: messageId,
      role: "assistant",
      text: "The provider is inspecting the task.",
      turnId,
      streaming: false,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [
    {
      id: EventId.make("activity-managed"),
      tone: "info",
      kind: "jarvis.task.created",
      summary: "Started by Jarvis",
      payload: { objective: "Implement the managed task" },
      turnId: null,
      createdAt: "2026-08-14T00:00:00.000Z",
    },
  ],
  checkpoints: [],
  session: null,
});

const activityEvent = (
  sequence: number,
  threadId: ThreadId,
  kind: string,
  turnId: TurnId | null,
  payload: unknown,
): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  type: "thread.activity-appended",
  occurredAt: "2026-08-14T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  payload: {
    threadId,
    activity: {
      id: EventId.make(`activity-${sequence}`),
      tone: kind.endsWith("failed") ? "error" : "info",
      kind,
      summary: kind,
      payload,
      turnId,
      createdAt: "2026-08-14T00:00:00.000Z",
    },
  },
  metadata: {},
});

const messageEvent = (
  sequence: number,
  threadId: ThreadId,
  turnId: TurnId,
  messageId: MessageId,
): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`message-event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  type: "thread.message-sent",
  occurredAt: "2026-08-14T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  payload: {
    threadId,
    messageId,
    role: "assistant",
    text: "ignored event text",
    turnId,
    streaming: false,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  },
  metadata: {},
});

const runReactorScenario = (
  events: ReadonlyArray<OrchestrationEvent>,
  thread: OrchestrationThread,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: string[] = [];
      const retained = new Map<string, string>();
      const layer = JarvisReportReactorLive.pipe(
        Layer.provideMerge(
          Layer.mock(OrchestrationEngineService)({
            dispatch: () => Effect.die("No command"),
            readEvents: () => Stream.fromIterable(events),
            streamDomainEvents: Stream.never,
            latestSequence: Effect.succeed(events.at(-1)?.sequence ?? 0),
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
                  calls.push(`append:${input.report.kind}`);
                  return true;
                }),
              stageWorkStartedCandidate: (input) =>
                Effect.sync(() => {
                  calls.push(`stage:${input.assistantMessageId}`);
                  if (retained.has(`${input.threadId}:${input.turnId}`)) return false;
                  retained.set(`${input.threadId}:${input.turnId}`, input.assistantMessageId);
                  return true;
                }),
              promoteWorkStartedCandidate: (input) =>
                Effect.sync(() => {
                  calls.push(`promote:${input.turnId}`);
                  return retained.has(`${input.threadId}:${input.turnId}`);
                }),
              dismissWorkStartedCandidate: (input) =>
                Effect.sync(() => calls.push(`dismiss:${input.turnId}`)),
              dismissAttention: (input) =>
                Effect.sync(() => calls.push(`attention:${input.requestId}`)),
              advanceSourceSequence: (sequence) =>
                Effect.sync(() => calls.push(`advance:${sequence}`)),
              latestSourceSequence: Effect.succeed(0),
              claimSpeech: () => Effect.succeed("missing"),
              confirmSpeech: () => Effect.succeed("missing"),
              releaseSpeech: () => Effect.succeed("missing"),
              acknowledge: (_session, sequence) => Effect.succeed(sequence),
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
      return calls;
    }),
  );

it.effect("skips buffered replay-live overlap without regressing the report cursor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-replay-live-overlap");
      const turnId = TurnId.make("turn-replay-live-overlap");
      const messageId = MessageId.make("message-replay-live-overlap");
      const message = messageEvent(10, threadId, turnId, messageId);
      const tool = activityEvent(11, threadId, "tool.started", turnId, {});
      const earlierTool = activityEvent(9, threadId, "tool.started", turnId, {});
      const calls: string[] = [];
      const thread = makeManagedThread(
        threadId,
        ProjectId.make("project-replay-live-overlap"),
        turnId,
        messageId,
      );
      const layer = JarvisReportReactorLive.pipe(
        Layer.provideMerge(
          Layer.mock(OrchestrationEngineService)({
            dispatch: () => Effect.die("No command"),
            readEvents: () => Stream.make(message, tool),
            streamDomainEvents: Stream.fromIterable([earlierTool, tool]),
            latestSequence: Effect.succeed(11),
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
              append: () =>
                Effect.sync(() => {
                  calls.push("append");
                  return true;
                }),
              stageWorkStartedCandidate: (input) =>
                Effect.sync(() => {
                  calls.push(`stage:${input.assistantMessageId}`);
                  return true;
                }),
              promoteWorkStartedCandidate: (input) =>
                Effect.sync(() => {
                  calls.push(`promote:${input.sourceSequence}`);
                  return true;
                }),
              dismissWorkStartedCandidate: () => Effect.void,
              dismissAttention: () => Effect.void,
              advanceSourceSequence: (sequence) =>
                Effect.sync(() => calls.push(`advance:${sequence}`)),
              latestSourceSequence: Effect.succeed(0),
              claimSpeech: () => Effect.succeed("missing"),
              confirmSpeech: () => Effect.succeed("missing"),
              releaseSpeech: () => Effect.succeed("missing"),
              acknowledge: (_session, sequence) => Effect.succeed(sequence),
              subscribe: () => Stream.empty,
            }),
          ),
        ),
      );
      const reactor = yield* JarvisReportReactor.pipe(Effect.provide(layer));
      yield* reactor.start();
      yield* reactor.drain;
      assert.deepEqual(
        calls.filter((call) => call.startsWith("stage:")),
        [`stage:${messageId}`],
      );
      assert.deepEqual(
        calls.filter((call) => call.startsWith("promote:")),
        ["promote:11"],
      );
      assert.deepEqual(
        calls.filter((call) => call.startsWith("advance:")),
        ["advance:10", "advance:11"],
      );
    }),
  ),
);

it.effect("message then finalized without tool dismisses the staged candidate", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-finalize-no-tool");
    const turnId = TurnId.make("turn-finalize-no-tool");
    const messageId = MessageId.make("message-finalize-no-tool");
    const calls = yield* runReactorScenario(
      [
        messageEvent(10, threadId, turnId, messageId),
        activityEvent(11, threadId, "provider.turn.result-finalized", turnId, {
          turnId,
          assistantMessageId: messageId,
          state: "completed",
        }),
      ],
      makeManagedThread(threadId, ProjectId.make("project-finalize"), turnId, messageId),
    );
    assert.isTrue(calls.some((call) => call.startsWith("stage:")));
    assert.isTrue(calls.some((call) => call.startsWith("dismiss:")));
    assert.isFalse(calls.some((call) => call.startsWith("promote:")));
    assert.isFalse(calls.some((call) => call.startsWith("append:work-started")));
  }),
);

it.effect("attention dismisses before append both before and after promotion", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-attention-order");
    const turnId = TurnId.make("turn-attention-order");
    const messageId = MessageId.make("message-attention-order");
    const thread = makeManagedThread(
      threadId,
      ProjectId.make("project-attention"),
      turnId,
      messageId,
    );
    const before = yield* runReactorScenario(
      [
        messageEvent(1, threadId, turnId, messageId),
        activityEvent(2, threadId, "user-input.requested", turnId, {
          requestId: "before",
          questions: [{ question: "Continue?" }],
        }),
      ],
      thread,
    );
    assert.isTrue(before.indexOf(`dismiss:${turnId}`) < before.indexOf("append:waiting-for-input"));
    const after = yield* runReactorScenario(
      [
        messageEvent(1, threadId, turnId, messageId),
        activityEvent(2, threadId, "tool.started", turnId, {}),
        activityEvent(3, threadId, "user-input.requested", turnId, {
          requestId: "after",
          questions: [{ question: "Continue?" }],
        }),
      ],
      thread,
    );
    assert.isTrue(after.indexOf(`promote:${turnId}`) < after.indexOf(`dismiss:${turnId}`));
    assert.isTrue(after.indexOf(`dismiss:${turnId}`) < after.indexOf("append:waiting-for-input"));
  }),
);

for (const state of ["completed", "failed", "interrupted"] as const) {
  it.effect(`reactor dismisses a ${state} finalized turn`, () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`thread-${state}-dismiss`);
      const turnId = TurnId.make(`turn-${state}-dismiss`);
      const messageId = MessageId.make(`message-${state}-dismiss`);
      const calls = yield* runReactorScenario(
        [
          messageEvent(1, threadId, turnId, messageId),
          activityEvent(2, threadId, "provider.turn.result-finalized", turnId, {
            turnId,
            assistantMessageId: null,
            state,
          }),
        ],
        makeManagedThread(threadId, ProjectId.make(`project-${state}`), turnId, messageId),
      );
      assert.include(calls, `dismiss:${turnId}`);
      assert.isFalse(calls.some((call) => call === "append:work-started"));
    }),
  );
}

it.effect("stages and promotes only the provider-authored same-turn work start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-work-start-reactor");
      const projectId = ProjectId.make("project-work-start-reactor");
      const turnId = TurnId.make("turn-work-start-reactor");
      const otherTurnId = TurnId.make("turn-other-reactor");
      const messageId = MessageId.make("message-work-start-reactor");
      const thread = makeManagedThread(threadId, projectId, turnId, messageId);
      const staged: string[] = [];
      const promoted: Array<{ turnId: string; sourceSequence: number; result: boolean }> = [];
      const dismissed: string[] = [];
      const advances: number[] = [];
      const appended: Array<{ sourceSequence: number; kind: string; turnId?: string }> = [];
      let projectedThrough = 0;
      const messageEvent: OrchestrationEvent = {
        sequence: 2,
        eventId: EventId.make("event-message-start"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.message-sent",
        occurredAt: "2026-08-14T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        payload: {
          threadId,
          messageId,
          role: "assistant",
          text: "",
          turnId,
          streaming: false,
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
        },
        metadata: {},
      };
      const events = [
        activityEvent(1, threadId, "tool.started", otherTurnId, { toolName: "before-message" }),
        messageEvent,
        activityEvent(3, threadId, "checkpoint.capture.failed", turnId, { message: "optional" }),
        activityEvent(4, threadId, "tool.started", turnId, { toolName: "provider-tool" }),
        activityEvent(5, threadId, "runtime.error", turnId, { message: "Provider stopped." }),
        activityEvent(6, threadId, "provider.turn.result-finalized", turnId, {
          turnId,
          assistantMessageId: messageId,
          state: "completed",
        }),
        activityEvent(7, threadId, "tool.started", otherTurnId, { toolName: "cross-turn" }),
      ];
      const layer = JarvisReportReactorLive.pipe(
        Layer.provideMerge(
          Layer.mock(OrchestrationEngineService)({
            dispatch: () => Effect.die("No command is dispatched in this test"),
            readEvents: () => Stream.fromIterable(events),
            streamDomainEvents: Stream.never,
            latestSequence: Effect.succeed(7),
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
                  appended.push({
                    sourceSequence: input.sourceSequence,
                    kind: input.report.kind,
                    ...(input.report.turnId === undefined ? {} : { turnId: input.report.turnId }),
                  });
                  return true;
                }),
              stageWorkStartedCandidate: (input) =>
                Effect.sync(() => {
                  staged.push(`${input.threadId}:${input.turnId}`);
                  return true;
                }),
              promoteWorkStartedCandidate: (input) =>
                Effect.sync(() => {
                  const result = staged.includes(`${input.threadId}:${input.turnId}`);
                  promoted.push({
                    turnId: input.turnId,
                    sourceSequence: input.sourceSequence,
                    result,
                  });
                  return result;
                }),
              dismissWorkStartedCandidate: (input) =>
                Effect.sync(() => dismissed.push(`${input.threadId}:${input.turnId}`)),
              dismissAttention: () => Effect.void,
              advanceSourceSequence: (sourceSequence) =>
                Effect.sync(() => {
                  advances.push(sourceSequence);
                  projectedThrough = sourceSequence;
                }),
              latestSourceSequence: Effect.succeed(0),
              claimSpeech: () => Effect.succeed("missing"),
              confirmSpeech: () => Effect.succeed("missing"),
              releaseSpeech: () => Effect.succeed("missing"),
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

      assert.deepEqual(staged, [`${threadId}:${turnId}`]);
      assert.deepEqual(promoted, [
        { turnId: otherTurnId, sourceSequence: 1, result: false },
        { turnId, sourceSequence: 4, result: true },
        { turnId: otherTurnId, sourceSequence: 7, result: false },
      ]);
      assert.deepEqual(appended, [{ sourceSequence: 5, kind: "failed", turnId }]);
      assert.deepEqual(dismissed, [`${threadId}:${turnId}`, `${threadId}:${turnId}`]);
      assert.deepEqual(advances, [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(projectedThrough, 7);
    }),
  ),
);
