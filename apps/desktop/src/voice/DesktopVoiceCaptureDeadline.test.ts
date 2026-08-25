import { describe, expect, it } from "@effect/vitest";

import {
  DESKTOP_VOICE_CAPTURE_DEADLINE_MS,
  DESKTOP_VOICE_FIRST_AUDIO_FRAME_DEADLINE_MS,
  createDesktopVoiceCaptureDeadline,
} from "./DesktopVoiceCaptureDeadline.ts";

describe("DesktopVoiceCaptureDeadline", () => {
  it("expires once and ignores stale callbacks after clear", () => {
    let nextHandle = 0;
    const callbacks = new Map<number, () => void>();
    const cleared: number[] = [];
    const deadline = createDesktopVoiceCaptureDeadline({
      scheduler: {
        setTimeout: (callback, delayMs) => {
          expect(delayMs).toBe(DESKTOP_VOICE_CAPTURE_DEADLINE_MS);
          const handle = nextHandle++;
          callbacks.set(handle, callback);
          return handle;
        },
        clearTimeout: (handle) => {
          cleared.push(handle as number);
        },
      },
    });
    let expirations = 0;
    deadline.arm(() => {
      expirations += 1;
    });
    const first = callbacks.get(0);
    expect(first).toBeDefined();
    first?.();
    first?.();
    expect(expirations).toBe(1);

    deadline.arm(() => {
      expirations += 1;
    });
    deadline.clear();
    callbacks.get(1)?.();
    expect(expirations).toBe(1);
    expect(cleared).toEqual([1]);
  });

  it("supports a short first-audio deadline without stale cancellation", () => {
    const callbacks = new Map<number, () => void>();
    const deadline = createDesktopVoiceCaptureDeadline({
      delayMs: DESKTOP_VOICE_FIRST_AUDIO_FRAME_DEADLINE_MS,
      scheduler: {
        setTimeout: (callback, delayMs) => {
          expect(delayMs).toBe(DESKTOP_VOICE_FIRST_AUDIO_FRAME_DEADLINE_MS);
          callbacks.set(callbacks.size, callback);
          return callbacks.size - 1;
        },
        clearTimeout: () => undefined,
      },
    });
    let expired = 0;
    deadline.arm(() => {
      expired += 1;
    });
    deadline.clear();
    callbacks.get(0)?.();
    expect(expired).toBe(0);
    deadline.arm(() => {
      expired += 1;
    });
    callbacks.get(1)?.();
    expect(expired).toBe(1);
  });
});
