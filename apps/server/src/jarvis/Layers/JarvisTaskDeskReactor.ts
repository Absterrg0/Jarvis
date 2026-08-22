import {
  type JarvisTaskDeskTaskState,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";
import {
  JarvisTaskDeskReactor,
  type JarvisTaskDeskReactorShape,
} from "../Services/JarvisTaskDeskReactor.ts";

export function taskDeskStateForEvent(event: OrchestrationEvent): JarvisTaskDeskTaskState | null {
  if (event.type === "thread.session-set") {
    if (event.payload.session.status === "ready") return "ready";
    if (event.payload.session.status === "error") return "failed";
    if (event.payload.session.status === "interrupted") return "interrupted";
    return null;
  }
  if (event.type !== "thread.activity-appended") return null;
  if (
    event.payload.activity.kind === "approval.resolved" ||
    event.payload.activity.kind === "user-input.resolved"
  ) {
    return "running";
  }
  if (event.payload.activity.kind === "user-input.requested") return "waiting-for-input";
  if (event.payload.activity.kind === "approval.requested") return "waiting-for-approval";
  if (event.payload.activity.kind === "runtime.error") {
    return "failed";
  }
  if (
    event.payload.activity.kind === "checkpoint.capture.failed" ||
    event.payload.activity.kind === "checkpoint.revert.failed"
  ) {
    return null;
  }
  if (
    event.payload.activity.kind.endsWith(".failed") &&
    event.payload.activity.kind !== "provider.approval.respond.failed" &&
    event.payload.activity.kind !== "provider.user-input.respond.failed"
  )
    return "failed";
  return null;
}

const make = Effect.gen(function* () {
  const orchestration = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const taskDesk = yield* JarvisTaskDesk;

  const processLifecycle = Effect.fn("JarvisTaskDeskReactor.processLifecycle")(function* (input: {
    readonly threadId: ThreadId;
    readonly state: JarvisTaskDeskTaskState;
  }) {
    const detail = yield* projections.getThreadDetailById(input.threadId);
    if (Option.isNone(detail)) return;
    const shell = yield* projections.getThreadShellById(input.threadId);
    const state = Option.match(shell, {
      onNone: () => input.state,
      onSome: (current) =>
        current.hasPendingApprovals
          ? ("waiting-for-approval" as const)
          : current.hasPendingUserInput
            ? ("waiting-for-input" as const)
            : input.state,
    });
    const marker = detail.value.activities.findLast(
      (activity) => activity.kind === "jarvis.task.created",
    );
    if (marker === undefined) return;
    const markerPayload =
      typeof marker.payload === "object" && marker.payload !== null ? marker.payload : undefined;
    const objective =
      markerPayload !== undefined &&
      "objective" in markerPayload &&
      typeof markerPayload.objective === "string" &&
      markerPayload.objective.trim().length > 0
        ? markerPayload.objective.trim()
        : detail.value.messages.find((message) => message.role === "user")?.text.trim() ||
          detail.value.title;
    yield* taskDesk.observeLifecycle({
      task: {
        threadId: detail.value.id,
        projectId: detail.value.projectId,
        title: detail.value.title,
        objective,
        state,
        voiceAliases: [],
      },
    });
  });

  const worker = yield* makeDrainableWorker(
    (input: { readonly threadId: ThreadId; readonly state: JarvisTaskDeskTaskState }) =>
      processLifecycle(input).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Jarvis task lifecycle could not be projected", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );
  const reconcileThread: JarvisTaskDeskReactorShape["reconcileThread"] = (threadId, state) =>
    worker.enqueue({ threadId, state });
  const start: JarvisTaskDeskReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestration.streamDomainEvents, (event) => {
        const state = taskDeskStateForEvent(event);
        if (state === null) return Effect.void;
        if (event.type !== "thread.session-set" && event.type !== "thread.activity-appended") {
          return Effect.void;
        }
        return reconcileThread(event.payload.threadId, state);
      }),
    );
    const trackedThreadIds = yield* taskDesk.listTrackedThreadIds().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Jarvis task desk startup reconciliation could not list tasks", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([])),
      ),
    );
    for (const threadId of trackedThreadIds) {
      const shell = yield* projections
        .getThreadShellById(threadId)
        .pipe(Effect.catchCause(() => Effect.succeed(Option.none())));
      if (Option.isNone(shell)) continue;
      const state: JarvisTaskDeskTaskState = shell.value.hasPendingApprovals
        ? "waiting-for-approval"
        : shell.value.hasPendingUserInput
          ? "waiting-for-input"
          : shell.value.session?.status === "error"
            ? "failed"
            : shell.value.session?.status === "interrupted"
              ? "interrupted"
              : shell.value.session?.status === "ready"
                ? "ready"
                : "running";
      yield* reconcileThread(threadId, state);
    }
  });

  return { start, reconcileThread, drain: worker.drain } satisfies JarvisTaskDeskReactorShape;
});

export const JarvisTaskDeskReactorLive = Layer.effect(JarvisTaskDeskReactor, make);
