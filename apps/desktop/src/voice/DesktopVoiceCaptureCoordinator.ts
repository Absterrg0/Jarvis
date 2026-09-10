// @effect-diagnostics globalTimers:off

import {
  isVoiceCaptureErrorCode,
  type VoiceCaptureErrorCode,
} from "@t3tools/jarvis-native-voice/desktop-native-voice";

// Capture owns both its result guard and its bounded lifetime. Keeping the
// timer here prevents a second lifecycle object from outliving a capture.
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

export type DesktopVoiceCaptureSettlement =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string; readonly code?: VoiceCaptureErrorCode };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errorCode(cause: unknown): VoiceCaptureErrorCode | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return isVoiceCaptureErrorCode(cause.code) ? cause.code : undefined;
}

/**
 * Delivers a native capture result only while that exact capture is active.
 * A cancelled capture may settle after a replacement starts; its result must
 * not clear the replacement's deadline or move the worker back to ready.
 */
export function bindDesktopVoiceCaptureResult<T>(input: {
  readonly capture: T;
  readonly result: Promise<string>;
  readonly isActive: (capture: T) => boolean;
  readonly onSettled: (settlement: DesktopVoiceCaptureSettlement) => void;
}): void {
  void input.result.then(
    (text) => {
      if (input.isActive(input.capture)) input.onSettled({ ok: true, text });
    },
    (cause) => {
      if (input.isActive(input.capture)) {
        const code = errorCode(cause);
        input.onSettled({
          ok: false,
          message: errorMessage(cause),
          ...(code === undefined ? {} : { code }),
        });
      }
    },
  );
}
