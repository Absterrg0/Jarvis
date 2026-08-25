// @effect-diagnostics globalTimers:off

export const DESKTOP_VOICE_CAPTURE_DEADLINE_MS = 30_000;
export const DESKTOP_VOICE_FIRST_AUDIO_FRAME_DEADLINE_MS = 5_000;

export interface DesktopVoiceCaptureDeadlineScheduler {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const defaultScheduler: DesktopVoiceCaptureDeadlineScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Owns one capture deadline and invalidates stale callbacks when a capture is
 * manually completed or replaced. The worker uses this seam so a native
 * microphone cannot remain open indefinitely when a release command is lost.
 */
export function createDesktopVoiceCaptureDeadline(input?: {
  readonly scheduler?: DesktopVoiceCaptureDeadlineScheduler;
  readonly delayMs?: number;
}) {
  const scheduler = input?.scheduler ?? defaultScheduler;
  const delayMs = input?.delayMs ?? DESKTOP_VOICE_CAPTURE_DEADLINE_MS;
  let active: { readonly generation: number; readonly handle: unknown } | null = null;
  let generation = 0;

  const clear = (): void => {
    if (active === null) return;
    scheduler.clearTimeout(active.handle);
    active = null;
  };

  const arm = (onExpire: () => void): void => {
    clear();
    const nextGeneration = generation + 1;
    generation = nextGeneration;
    const handle = scheduler.setTimeout(() => {
      if (active?.generation !== nextGeneration) return;
      active = null;
      onExpire();
    }, delayMs);
    active = { generation: nextGeneration, handle };
  };

  return { arm, clear };
}
