import { describe, expect, it } from "@effect/vitest";

import {
  DESKTOP_VOICE_CAPTURE_DEADLINE_MS,
  DESKTOP_VOICE_FIRST_AUDIO_FRAME_DEADLINE_MS,
  bindDesktopVoiceCaptureResult,
  createDesktopVoiceCaptureDeadline,
} from "./DesktopVoiceCaptureCoordinator.ts";
import { createVoiceCaptureError } from "@t3tools/jarvis-native-voice/desktop-native-voice";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("DesktopVoiceCaptureCoordinator", () => {
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
        clearTimeout: (handle) => cleared.push(handle as number),
      },
    });
    let expirations = 0;
    deadline.arm(() => {
      expirations += 1;
    });
    callbacks.get(0)?.();
    callbacks.get(0)?.();
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

  it("ignores a cancelled capture settling after its replacement starts", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let active: "first" | "second" | null = "first";
    const settlements: string[] = [];

    bindDesktopVoiceCaptureResult({
      capture: "first" as const,
      result: first.promise,
      isActive: (capture) => active === capture,
      onSettled: (settlement) =>
        settlements.push(settlement.ok ? settlement.text : settlement.message),
    });
    active = null;
    active = "second";
    bindDesktopVoiceCaptureResult({
      capture: "second" as const,
      result: second.promise,
      isActive: (capture) => active === capture,
      onSettled: (settlement) =>
        settlements.push(settlement.ok ? settlement.text : settlement.message),
    });

    first.resolve("stale first result");
    await Promise.resolve();
    expect(settlements).toEqual([]);

    second.resolve("current second result");
    await Promise.resolve();
    expect(settlements).toEqual(["current second result"]);
  });

  it("preserves a typed recognition failure instead of reclassifying its wording", async () => {
    const result = deferred<string>();
    let settlement: { readonly ok: boolean; readonly code?: string } | undefined;
    bindDesktopVoiceCaptureResult({
      capture: "active",
      result: result.promise,
      isActive: () => true,
      onSettled: (next) => {
        settlement = next;
      },
    });

    result.reject(
      createVoiceCaptureError(
        "transcription-failed",
        "I didn't hear a complete instruction. Try again.",
      ),
    );
    await Promise.resolve();

    expect(settlement).toMatchObject({ ok: false, code: "transcription-failed" });
  });
});
