import type { CirceTaskDeskTaskView } from "@t3tools/contracts";
import type { CircePresenceMode } from "@circe/client-runtime/presence";

export type { CircePresenceMode } from "@circe/client-runtime/presence";

export function circePresenceMode(input: {
  readonly listening: boolean;
  readonly submitting: boolean;
  readonly activeTaskState: CirceTaskDeskTaskView["state"] | null;
  readonly error: string | null;
}): CircePresenceMode {
  if (input.error !== null) return "error";
  if (input.listening) return "listening";
  if (
    input.activeTaskState === "waiting-for-input" ||
    input.activeTaskState === "waiting-for-approval"
  ) {
    return "attention";
  }
  if (input.submitting || input.activeTaskState === "running") return "working";
  return "idle";
}
