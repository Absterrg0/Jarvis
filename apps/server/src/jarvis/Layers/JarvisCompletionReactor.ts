import {
  CommandId,
  EventId,
  MessageId,
  JarvisTurnResultFinalizedActivityPayload,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  JarvisCompletionReactor,
  type JarvisCompletionReactorShape,
} from "../Services/JarvisCompletionReactor.ts";

const MAX_STARTUP_COMPLETION_REPAIR_EVENTS = 10_000;
const isTurnResultFinalizedPayload = Schema.is(JarvisTurnResultFinalizedActivityPayload);

function isRelevantDomainEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.turn-diff-completed" ||
    (event.type === "thread.activity-appended" &&
      (event.payload.activity.kind === "jarvis.task.created" ||
        event.payload.activity.kind === "jarvis.review.source" ||
        event.payload.activity.kind === "provider.turn.result-finalized"))
  );
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  return (
    left !== null && left !== undefined && right !== null && right !== undefined && left === right
  );
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestration = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;

  const resolveThreadDetail = Effect.fn("JarvisCompletionReactor.resolveThreadDetail")(function* (
    threadId: ThreadId,
  ) {
    return yield* projections.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));
  });

  const appendCompletionReady = Effect.fn("JarvisCompletionReactor.appendCompletionReady")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly assistantMessageId: MessageId;
      readonly createdAt: string;
    }) {
      yield* orchestration.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("jarvis-turn-completion-ready"),
        threadId: input.threadId,
        activity: {
          id: yield* serverEventId,
          tone: "info",
          kind: "jarvis.turn.completion-ready",
          summary: "Jarvis completion ready",
          payload: {
            turnId: input.turnId,
            assistantMessageId: input.assistantMessageId,
            state: "completed",
          },
          turnId: input.turnId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    },
  );

  const reconcileCompletion = Effect.fn("JarvisCompletionReactor.reconcileCompletion")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly createdAt: string;
    }) {
      const thread = yield* resolveThreadDetail(input.threadId);
      if (thread === undefined) return;
      if (
        !thread.activities.some(
          (activity) =>
            activity.kind === "jarvis.task.created" || activity.kind === "jarvis.review.source",
        )
      )
        return;
      if (
        thread.activities.some(
          (activity) =>
            activity.kind === "jarvis.turn.completion-ready" &&
            isTurnResultFinalizedPayload(activity.payload) &&
            sameId(activity.payload.turnId, input.turnId),
        )
      )
        return;
      const terminalResult = thread.activities.findLast(
        (activity) =>
          activity.kind === "provider.turn.result-finalized" &&
          isTurnResultFinalizedPayload(activity.payload) &&
          sameId(activity.payload.turnId, input.turnId) &&
          activity.payload.state === "completed" &&
          activity.payload.assistantMessageId !== null,
      );
      if (
        terminalResult === undefined ||
        !isTurnResultFinalizedPayload(terminalResult.payload) ||
        terminalResult.payload.assistantMessageId === null
      )
        return;
      // Checkpoints are optional workspace bookkeeping. The provider's terminal
      // result is authoritative for Jarvis delivery; a VCS failure must not
      // suppress the completion report or strand the origin interaction.
      yield* appendCompletionReady({
        threadId: thread.id,
        turnId: input.turnId,
        assistantMessageId: terminalResult.payload.assistantMessageId,
        createdAt: input.createdAt,
      });
    },
  );

  const reconcileLatest = Effect.fn("JarvisCompletionReactor.reconcileLatest")(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);
    if (thread === undefined) return;
    const terminalResult = thread.activities.findLast(
      (activity) =>
        activity.kind === "provider.turn.result-finalized" &&
        isTurnResultFinalizedPayload(activity.payload) &&
        activity.payload.state === "completed" &&
        activity.payload.assistantMessageId !== null,
    );
    if (terminalResult === undefined || !isTurnResultFinalizedPayload(terminalResult.payload))
      return;
    yield* reconcileCompletion({
      threadId: input.threadId,
      turnId: terminalResult.payload.turnId,
      createdAt: input.createdAt,
    });
  });

  const process = (event: OrchestrationEvent) => {
    if (event.type === "thread.turn-diff-completed" && event.payload.status !== "missing") {
      return reconcileCompletion({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        createdAt: event.payload.completedAt,
      });
    }
    if (event.type !== "thread.activity-appended") return Effect.void;
    if (
      event.payload.activity.kind === "jarvis.task.created" ||
      event.payload.activity.kind === "jarvis.review.source"
    ) {
      return reconcileLatest({
        threadId: event.payload.threadId,
        createdAt: event.payload.activity.createdAt,
      });
    }
    if (
      event.payload.activity.kind === "provider.turn.result-finalized" &&
      isTurnResultFinalizedPayload(event.payload.activity.payload)
    ) {
      const payload = event.payload.activity.payload;
      if (payload.state !== "completed" || payload.assistantMessageId === null) return Effect.void;
      return reconcileCompletion({
        threadId: event.payload.threadId,
        turnId: payload.turnId,
        createdAt: event.payload.activity.createdAt,
      });
    }
    return Effect.void;
  };

  const worker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    process(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Jarvis completion reactor failed to process event", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  const start: JarvisCompletionReactorShape["start"] = Effect.fn("JarvisCompletionReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(orchestration.streamDomainEvents, (event) =>
          isRelevantDomainEvent(event) ? worker.enqueue(event) : Effect.void,
        ),
      );
      const latestSequence = yield* orchestration.latestSequence;
      const replayFromSequence = Math.max(0, latestSequence - MAX_STARTUP_COMPLETION_REPAIR_EVENTS);
      yield* orchestration
        .readEvents(replayFromSequence, MAX_STARTUP_COMPLETION_REPAIR_EVENTS)
        .pipe(
          Stream.runForEach((event) => {
            if (
              event.type !== "thread.activity-appended" ||
              event.payload.activity.kind !== "provider.turn.result-finalized" ||
              !isTurnResultFinalizedPayload(event.payload.activity.payload) ||
              event.payload.activity.payload.state !== "completed" ||
              event.payload.activity.payload.assistantMessageId === null
            ) {
              return Effect.void;
            }
            return worker.enqueue(event);
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Jarvis completion reactor startup repair failed", {
              cause: Cause.pretty(cause),
              replayFromSequence,
              latestSequence,
            }),
          ),
        );
      yield* worker.drain;
    },
  );
  return { start, drain: worker.drain } satisfies JarvisCompletionReactorShape;
});

export const JarvisCompletionReactorLive = Layer.effect(JarvisCompletionReactor, make);
