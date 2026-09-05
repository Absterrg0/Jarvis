import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildJarvisPresentation } from "../presentation.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { JarvisPresentationFanout } from "../Services/JarvisPresentationFanout.ts";
import { JarvisPresentationFanoutLive } from "./JarvisPresentationFanout.ts";

const threadFor = (threadId: string, originInteractionId: string): OrchestrationThread => ({
  id: ThreadId.make(threadId),
  projectId: ProjectId.make("project-fanout"),
  title: "Fanout task",
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
  messages: [
    {
      id: MessageId.make(`message-user-${threadId}`),
      role: "user",
      text: "Do the thing.",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
    {
      id: MessageId.make(`message-final-${threadId}`),
      role: "assistant",
      text: `Done for ${originInteractionId}.`,
      turnId: TurnId.make(`turn-${threadId}`),
      streaming: false,
      createdAt: "2026-08-30T00:01:00.000Z",
      updatedAt: "2026-08-30T00:01:00.000Z",
    },
  ],
  activities: [
    {
      id: EventId.make(`event-origin-${threadId}`),
      tone: "info",
      kind: "jarvis.task.created",
      summary: "Started by Jarvis",
      payload: {
        objective: "Do the thing.",
        messageId: MessageId.make(`message-user-${threadId}`),
        taskRef: {
          executionNodeId: EnvironmentId.make("node-fanout"),
          threadId: ThreadId.make(threadId),
        },
        requestMetadata: {
          requestId: `request-${threadId}`,
          origin: { originInteractionId },
        },
      },
      turnId: null,
      createdAt: "2026-08-30T00:00:00.000Z",
    },
  ],
  proposedPlans: [],
  checkpoints: [],
  session: null,
});

const completionEvent = (
  threadId: string,
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> => ({
  sequence: 2,
  eventId: EventId.make(`event-completed-${threadId}`),
  aggregateKind: "thread",
  aggregateId: ThreadId.make(threadId),
  occurredAt: "2026-08-30T00:02:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.activity-appended",
  payload: {
    threadId: ThreadId.make(threadId),
    activity: {
      id: EventId.make(`event-completed-${threadId}`),
      tone: "info",
      kind: "provider.turn.result-finalized",
      summary: "Turn completed",
      payload: {
        turnId: `turn-${threadId}`,
        userMessageId: `message-user-${threadId}`,
        assistantMessageId: `message-final-${threadId}`,
        state: "completed",
      },
      turnId: TurnId.make(`turn-${threadId}`),
      createdAt: "2026-08-30T00:02:00.000Z",
    },
  },
});

const harness = (threads: ReadonlyArray<OrchestrationThread>) =>
  Effect.gen(function* () {
    const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const detailReads = yield* Ref.make(0);
    const engineLayer = Layer.mock(OrchestrationEngineService)({
      dispatch: () => Effect.die("dispatch is not stubbed in the fanout test"),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.fromPubSub(liveEvents),
      latestSequence: Effect.succeed(0),
    });
    const projectionsLayer = Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: (threadId: ThreadId) =>
        Effect.gen(function* () {
          yield* Ref.update(detailReads, (count) => count + 1);
          const thread = threads.find((candidate) => candidate.id === threadId);
          return thread === undefined ? Option.none() : Option.some(thread);
        }),
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({
            id: ProjectId.make("project-fanout"),
            title: "Fanout project",
            workspaceRoot: "/work/fanout",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-30T00:00:00.000Z",
            updatedAt: "2026-08-30T00:00:00.000Z",
          }),
        ),
      getShellSnapshot: () => Effect.die("shell snapshot is not stubbed in the fanout test"),
    });
    const layer = JarvisPresentationFanoutLive.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(projectionsLayer),
    );
    return { liveEvents, detailReads, layer };
  });

describe("Jarvis presentation fanout", () => {
  it("builds a completion presentation from the fixture", () => {
    const presentation = buildJarvisPresentation(
      completionEvent("thread-one"),
      threadFor("thread-one", "interaction-one"),
      "Fanout project",
    );
    expect(presentation).not.toBeNull();
  });

  it("projects each event once and routes it to the matching origin only", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* harness([
          threadFor("thread-one", "interaction-one"),
          threadFor("thread-two", "interaction-two"),
        ]);
        const { liveEvents, detailReads, layer } = setup;
        yield* Effect.gen(function* () {
          const fanout = yield* JarvisPresentationFanout;
          const firstFiber = yield* Effect.forkChild(
            Stream.runCollect(
              fanout.subscribe({ originInteractionId: "interaction-one" }).pipe(Stream.take(1)),
            ),
          );
          const secondFiber = yield* Effect.forkChild(
            Stream.runCollect(
              fanout.subscribe({ originInteractionId: "interaction-two" }).pipe(Stream.take(1)),
            ),
          );
          // Let both subscriptions register: PubSub drops messages published
          // before a subscriber exists, and the pump owns the only durable
          // read. Fiber scheduling is sub-millisecond; this margin only
          // covers test scheduling, never product timing.
          yield* Effect.sleep("100 millis");

          yield* PubSub.publish(liveEvents, completionEvent("thread-one"));
          yield* PubSub.publish(liveEvents, completionEvent("thread-two"));

          const firstItems = yield* Fiber.join(firstFiber);
          const secondItems = yield* Fiber.join(secondFiber);

          expect(firstItems.length).toBe(1);
          expect(firstItems[0]?.text).toBe("Done for interaction-one.");
          expect(secondItems.length).toBe(1);
          expect(secondItems[0]?.text).toBe("Done for interaction-two.");
          // One projection read per event, not per subscriber: two events, two reads.
          expect(yield* Ref.get(detailReads)).toBe(2);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    );
  });

  it("gives late subscribers future events without replaying past speech", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* harness([threadFor("thread-one", "interaction-one")]);
        const { liveEvents, layer } = setup;
        yield* Effect.gen(function* () {
          const fanout = yield* JarvisPresentationFanout;
          const earlyFiber = yield* Effect.forkChild(
            Stream.runCollect(
              fanout.subscribe({ originInteractionId: "interaction-one" }).pipe(Stream.take(1)),
            ),
          );
          yield* Effect.sleep("100 millis");

          yield* PubSub.publish(liveEvents, completionEvent("thread-one"));
          const earlyItems = yield* Fiber.join(earlyFiber);
          expect(earlyItems.length).toBe(1);

          // Subscribed after the first completion: the past presentation must
          // not replay. A short live-clock window is enough for anything
          // deliverable to arrive.
          const lateItems = yield* Stream.runCollect(
            fanout.subscribe({ originInteractionId: "interaction-one" }).pipe(Stream.take(1)),
          ).pipe(Effect.timeoutOption("200 millis"));
          expect(lateItems._tag).toBe("None");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    );
  });
});
