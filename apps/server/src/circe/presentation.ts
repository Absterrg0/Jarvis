import {
  type CircePresentationEvent,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";

import {
  buildActivityPresentationForActivity,
  buildSessionPresentation,
  classifyActivityPresentationKind,
} from "@circe/core/buildPresentation";

/** Events that can change a Circe-owned task's user-facing state. */
export function isCircePresentationSource(event: OrchestrationEvent): boolean {
  if (event.type === "thread.session-set") return event.payload.session.status === "error";
  if (event.type !== "thread.activity-appended") return false;
  return classifyActivityPresentationKind(event.payload.activity) !== null;
}

/**
 * Adapt one already-projected T3 event into a short live presentation. The
 * task thread remains the source of truth. Returning null keeps ordinary T3
 * work and tasks without Circe origin metadata out of voice delivery.
 */
export function buildCircePresentation(
  event: OrchestrationEvent,
  thread: OrchestrationThread,
  projectTitle = "this project",
): CircePresentationEvent | null {
  if (event.type === "thread.activity-appended") {
    return buildActivityPresentationForActivity(thread, event.payload.activity, projectTitle);
  }
  if (event.type === "thread.session-set") {
    // ProviderRuntimeIngestion records the runtime error first and then
    // mirrors it onto the session read model. The activity is the live
    // presentation edge; suppress the derived session edge so one failure
    // cannot speak twice. Suppression requires the exact mirror: both the
    // turn and the message must correlate, so a different failure is never
    // silenced by an unrelated runtime error.
    const sessionTurnId = event.payload.session.activeTurnId;
    const sessionError = event.payload.session.lastError;
    const mirroredRuntimeError = thread.activities.some((activity) => {
      if (activity.kind !== "runtime.error") return false;
      const turnCorrelated =
        sessionTurnId === null ? activity.turnId === null : activity.turnId === sessionTurnId;
      const payload = activity.payload;
      const message =
        typeof payload === "object" && payload !== null && "message" in payload
          ? payload.message
          : undefined;
      const messageCorrelated =
        sessionError === null ? message === undefined : message === sessionError;
      return turnCorrelated && messageCorrelated;
    });
    if (mirroredRuntimeError) return null;
    return buildSessionPresentation(thread, event.payload.session, event.eventId);
  }
  return null;
}

export function isPresentationForOrigin(
  event: CircePresentationEvent,
  originInteractionId: string,
  originNodeId?: string,
): boolean {
  return (
    event.origin.originInteractionId === originInteractionId &&
    (originNodeId === undefined || event.origin.originNodeId === originNodeId)
  );
}
