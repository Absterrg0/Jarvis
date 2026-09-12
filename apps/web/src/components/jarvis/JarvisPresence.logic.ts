import type { JarvisTaskDeskTaskView } from "@t3tools/contracts";
import type { JarvisPresenceMode } from "@t3tools/jarvis-client-runtime/presence";

export type { JarvisPresenceMode } from "@t3tools/jarvis-client-runtime/presence";

export function jarvisPresenceMode(input: {
  readonly listening: boolean;
  readonly submitting: boolean;
  readonly activeTaskState: JarvisTaskDeskTaskView["state"] | null;
  readonly error: string | null;
}): JarvisPresenceMode {
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
