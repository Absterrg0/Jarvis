import type {
  JarvisPresentationEvent,
  OrchestrationEvent,
  OrchestrationThread,
} from "@t3tools/contracts";

import {
  buildActivityPresentationForActivity,
  buildSessionPresentation,
} from "@t3tools/jarvis-core/buildPresentation";

/** Events that can change a Jarvis-owned task's user-facing state. */
export function isJarvisPresentationSource(event: OrchestrationEvent): boolean {
  if (event.type === "thread.session-set") return event.payload.session.status === "error";
  if (event.type !== "thread.activity-appended") return false;
  const kind = event.payload.activity.kind;
  return (
    kind === "provider.turn.result-finalized" ||
    kind === "approval.requested" ||
    kind === "user-input.requested" ||
    kind === "runtime.error" ||
    kind.endsWith(".failed")
  );
}

/**
 * Adapt one already-projected T3 event into a short live presentation. The
 * task thread remains the source of truth. Returning null keeps ordinary T3
 * work and tasks without Jarvis origin metadata out of voice delivery.
 */
export function buildJarvisPresentation(
  event: OrchestrationEvent,
  thread: OrchestrationThread,
  projectTitle = "this project",
): JarvisPresentationEvent | null {
  if (event.type === "thread.activity-appended") {
    return buildActivityPresentationForActivity(thread, event.payload.activity, projectTitle);
  }
  if (event.type === "thread.session-set") {
    // ProviderRuntimeIngestion records the runtime error first and then
    // mirrors it onto the session read model. The activity is the live
    // presentation edge; suppress the derived session edge so one failure
    // cannot speak twice.
    const mirroredRuntimeError = thread.activities.some(
      (activity) =>
        activity.kind === "runtime.error" &&
        (event.payload.session.activeTurnId === null ||
          activity.turnId === null ||
          activity.turnId === event.payload.session.activeTurnId) &&
        (event.payload.session.lastError === null ||
          typeof activity.payload !== "object" ||
          activity.payload === null ||
          !("message" in activity.payload) ||
          activity.payload.message === event.payload.session.lastError),
    );
    if (mirroredRuntimeError) return null;
    return buildSessionPresentation(thread, event.payload.session, event.eventId);
  }
  return null;
}

export function isPresentationForOrigin(
  event: JarvisPresentationEvent,
  originInteractionId: string,
  originNodeId?: string,
): boolean {
  return (
    event.origin.originInteractionId === originInteractionId &&
    (originNodeId === undefined || event.origin.originNodeId === originNodeId)
  );
}
