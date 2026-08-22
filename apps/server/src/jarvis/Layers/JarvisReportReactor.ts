import type { OrchestrationEvent, OrchestrationThreadActivity } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  buildActivityVoiceReportForActivity,
  buildSessionVoiceReport,
  isClosedPendingRequestDetail,
} from "../buildVoiceReport.ts";
import { JarvisReportOutbox } from "../Services/JarvisReportOutbox.ts";
import {
  JarvisReportReactor,
  type JarvisReportReactorShape,
} from "../Services/JarvisReportReactor.ts";

export function isJarvisReportEvent(
  event: OrchestrationEvent,
): event is Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" | "thread.session-set" }
> {
  return (
    (event.type === "thread.activity-appended" &&
      (["user-input.requested", "approval.requested", "runtime.error"].includes(
        event.payload.activity.kind,
      ) ||
        ["user-input.resolved", "approval.resolved"].includes(event.payload.activity.kind) ||
        event.payload.activity.kind.endsWith(".failed") ||
        event.payload.activity.kind === "jarvis.turn.completion-ready")) ||
    (event.type === "thread.session-set" && event.payload.session.status === "error")
  );
}

const decodeRequest = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.String,
    message: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  }),
);
const requestFor = (payload: unknown) => Option.getOrNull(decodeRequest(payload));

export function attentionClosureForActivity(activity: OrchestrationThreadActivity): {
  readonly requestId: string;
  readonly kind: "waiting-for-input" | "approval-needed";
  readonly terminalFailure: boolean;
} | null {
  const request = requestFor(activity.payload);
  if (request === null) return null;
  if (activity.kind === "user-input.resolved" || activity.kind === "approval.resolved") {
    return {
      requestId: request.requestId,
      kind: activity.kind === "approval.resolved" ? "approval-needed" : "waiting-for-input",
      terminalFailure: false,
    };
  }
  if (
    (activity.kind === "provider.user-input.respond.failed" ||
      activity.kind === "provider.approval.respond.failed") &&
    isClosedPendingRequestDetail(request.message ?? request.detail ?? "")
  ) {
    return {
      requestId: request.requestId,
      kind:
        activity.kind === "provider.approval.respond.failed"
          ? "approval-needed"
          : "waiting-for-input",
      terminalFailure: true,
    };
  }
  return null;
}

const make = Effect.gen(function* () {
  const orchestration = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const outbox = yield* JarvisReportOutbox;
  const projectionBlocked = yield* Ref.make(false);

  const processEvent = Effect.fn("JarvisReportReactor.processEvent")(function* (
    event: OrchestrationEvent,
  ) {
    if (!isJarvisReportEvent(event)) {
      yield* outbox.advanceSourceSequence(event.sequence);
      return;
    }
    const attentionClosure =
      event.type === "thread.activity-appended"
        ? attentionClosureForActivity(event.payload.activity)
        : null;
    if (attentionClosure !== null) {
      yield* outbox.dismissAttention({
        threadId: event.payload.threadId,
        requestId: attentionClosure.requestId,
        kind: attentionClosure.kind,
      });
      if (!attentionClosure.terminalFailure) {
        yield* outbox.advanceSourceSequence(event.sequence);
        return;
      }
    }
    const detail = yield* projections.getThreadDetailById(event.payload.threadId);
    if (Option.isNone(detail)) {
      yield* outbox.advanceSourceSequence(event.sequence);
      return;
    }
    const project = yield* projections.getProjectShellById(detail.value.projectId);
    const report =
      event.type === "thread.activity-appended"
        ? buildActivityVoiceReportForActivity(
            detail.value,
            event.payload.activity,
            Option.isSome(project) ? project.value.title : "this project",
          )
        : buildSessionVoiceReport(
            detail.value,
            event.payload.session,
            detail.value.latestTurn === null
              ? `${event.payload.threadId}:session:${event.sequence}`
              : `${event.payload.threadId}:turn:${detail.value.latestTurn.turnId}:failed`,
          );
    const request =
      event.type === "thread.activity-appended" ? requestFor(event.payload.activity.payload) : null;
    if (report !== null) {
      yield* outbox.append({
        sourceSequence: event.sequence,
        report,
        ...(request === null ? {} : { requestId: request.requestId }),
      });
    }
    yield* outbox.advanceSourceSequence(event.sequence);
  });

  const processEventSafely = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (yield* Ref.get(projectionBlocked)) return;
      yield* processEvent(event);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Ref.set(projectionBlocked, true).pipe(
              Effect.andThen(
                Effect.logWarning("Jarvis report projection paused before its cursor advanced", {
                  aggregateId: event.aggregateId,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
      ),
    );
  const worker = yield* makeDrainableWorker(processEventSafely);
  const reconcile: JarvisReportReactorShape["reconcile"] = Effect.fn(
    "JarvisReportReactor.reconcile",
  )((event) => worker.enqueue(event));
  const start: JarvisReportReactorShape["start"] = Effect.fn("JarvisReportReactor.start")(
    function* () {
      const projectedThrough = yield* outbox.latestSourceSequence.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Jarvis report replay cursor could not be loaded", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(0)),
        ),
      );
      const liveBuffer = yield* Queue.unbounded<OrchestrationEvent>();
      yield* forkParked(
        Stream.runForEach(orchestration.streamDomainEvents, (event) =>
          Queue.offer(liveBuffer, event),
        ),
      );
      yield* orchestration.readEvents(projectedThrough, Number.MAX_SAFE_INTEGER).pipe(
        // Replay directly through the guarded processor. Enqueuing the full
        // history first lets an unbounded worker queue retain every event at
        // once on a fresh install or after a long outage.
        Stream.runForEach(processEventSafely),
        Effect.catchCause((cause) =>
          Ref.set(projectionBlocked, true).pipe(
            Effect.andThen(
              Effect.logWarning("Jarvis report startup replay failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
      );
      yield* worker.drain;
      yield* forkParked(Stream.runForEach(Stream.fromQueue(liveBuffer), reconcile));
    },
  );
  return { start, reconcile, drain: worker.drain } satisfies JarvisReportReactorShape;
});

export const JarvisReportReactorLive = Layer.effect(JarvisReportReactor, make);
