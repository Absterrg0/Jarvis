import type { DesktopJarvisVoiceState, JarvisTaskDeskTask } from "@t3tools/contracts";

export type JarvisPresenceMode =
  | "idle"
  | "listening"
  | "working"
  | "speaking"
  | "attention"
  | "error";

export function jarvisPresenceMode(input: {
  readonly listening: boolean;
  readonly submitting: boolean;
  readonly activeTaskState: JarvisTaskDeskTask["state"] | null;
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

export interface JarvisPresenceFrameScheduler {
  readonly request: (callback: (timestamp: number) => void) => number;
  readonly cancel: (handle: number) => void;
}

export function startJarvisPresenceBurst(input: {
  readonly mode: JarvisPresenceMode;
  readonly visible: boolean;
  readonly reducedMotion: boolean;
  readonly scheduler: JarvisPresenceFrameScheduler;
  readonly onProgress: (progress: number) => void;
  readonly now?: () => number;
  readonly durationMs?: number;
}): () => void {
  if (!input.visible || input.reducedMotion || input.mode === "idle") return () => undefined;

  const startedAt = input.now?.() ?? performance.now();
  const duration = Math.max(1, input.durationMs ?? 900);
  let stopped = false;
  let handle: number | null = null;
  const tick = (timestamp: number): void => {
    if (stopped) return;
    const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / duration));
    input.onProgress(progress);
    if (progress < 1) {
      handle = input.scheduler.request(tick);
    } else {
      handle = null;
    }
  };
  handle = input.scheduler.request(tick);

  return () => {
    stopped = true;
    if (handle !== null) {
      input.scheduler.cancel(handle);
      handle = null;
    }
  };
}
