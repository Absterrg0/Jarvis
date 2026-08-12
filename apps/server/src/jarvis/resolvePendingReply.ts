import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export type PendingJarvisReply =
  | {
      readonly kind: "user-input";
      readonly requestId: string;
      readonly questionIds: ReadonlyArray<string>;
    }
  | { readonly kind: "approval"; readonly requestId: string };

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : null;
}

export function resolvePendingReply(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingJarvisReply | null {
  const resolved = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "user-input.resolved" && activity.kind !== "approval.resolved") continue;
    const requestId = payloadRecord(activity)?.requestId;
    if (typeof requestId === "string") resolved.add(requestId);
  }

  for (const activity of activities.toReversed()) {
    if (activity.kind !== "user-input.requested" && activity.kind !== "approval.requested")
      continue;
    const payload = payloadRecord(activity);
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || resolved.has(requestId)) continue;
    if (activity.kind === "approval.requested") return { kind: "approval", requestId };
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];
    const questionIds = questions.flatMap((question) => {
      if (typeof question !== "object" || question === null || !("id" in question)) return [];
      return typeof question.id === "string" ? [question.id] : [];
    });
    return { kind: "user-input", requestId, questionIds };
  }
  return null;
}
