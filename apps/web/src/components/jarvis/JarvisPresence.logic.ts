import type { DesktopJarvisVoiceState, JarvisTaskDeskTaskView } from "@t3tools/contracts";
import type { JarvisPresenceMode } from "@t3tools/jarvis-client-runtime/presence";

export type { JarvisPresenceMode } from "@t3tools/jarvis-client-runtime/presence";

export function jarvisPresenceMode(input: {
  readonly listening: boolean;
  readonly submitting: boolean;
  readonly activeTaskState: JarvisTaskDeskTaskView["state"] | null;
  readonly error: string | null;
  readonly nativeVoiceState: DesktopJarvisVoiceState | null;
}): JarvisPresenceMode {
  if (input.error !== null || input.nativeVoiceState?.status === "error") return "error";
  if (input.nativeVoiceState?.status === "speaking") return "speaking";
  if (
    input.listening ||
    input.nativeVoiceState?.status === "capturing" ||
    input.nativeVoiceState?.status === "transcribing"
  )
    return "listening";
  if (
    input.activeTaskState === "waiting-for-input" ||
    input.activeTaskState === "waiting-for-approval"
  ) {
    return "attention";
  }
  if (input.submitting || input.activeTaskState === "running") return "working";
  return "idle";
}
