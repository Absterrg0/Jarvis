import type { JarvisTaskState, OrchestrationThreadShell } from "@t3tools/contracts";

export type JarvisTaskStateInput = Pick<OrchestrationThreadShell, "latestTurn" | "session"> &
  Partial<Pick<OrchestrationThreadShell, "hasPendingApprovals" | "hasPendingUserInput">>;

/** Whether T3 still has a provider turn that can be interrupted. */
export function hasActiveJarvisTurn(thread: JarvisTaskStateInput): boolean {
  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running"
  );
}

/** Derive the user-visible task state from the authoritative T3 thread projection. */
export function deriveJarvisTaskState(thread: JarvisTaskStateInput): JarvisTaskState {
  if (thread.hasPendingApprovals === true) return "waiting-for-approval";
  if (thread.hasPendingUserInput === true) return "waiting-for-input";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (
    thread.session?.status === "interrupted" ||
    thread.session?.status === "stopped" ||
    thread.latestTurn?.state === "interrupted"
  ) {
    return "interrupted";
  }
  if (thread.session?.status === "ready" || thread.latestTurn?.state === "completed") {
    return "ready";
  }
  if (thread.session === null && thread.latestTurn === null) return "ready";
  return hasActiveJarvisTurn(thread) ? "running" : "ready";
}
