import { describe, expect, it } from "vite-plus/test";

import {
  jarvisPresenceMode,
  startJarvisPresenceBurst,
  type JarvisPresenceFrameScheduler,
} from "./JarvisPresence.logic";
import { JARVIS_PRESENCE_MODE_LABELS, JARVIS_PRESENCE_PALETTE } from "./JarvisPresence";

describe("Jarvis presence", () => {
  it("keeps a stable semantic palette for every visible state", () => {
    expect(Object.keys(JARVIS_PRESENCE_PALETTE)).toEqual([
      "idle",
      "listening",
      "working",
      "speaking",
      "attention",
      "error",
    ]);
    expect(JARVIS_PRESENCE_PALETTE.idle[1]).toBeGreaterThan(JARVIS_PRESENCE_PALETTE.idle[0]);
    expect(JARVIS_PRESENCE_PALETTE.working[2]).toBeGreaterThan(JARVIS_PRESENCE_PALETTE.working[0]);
    expect(JARVIS_PRESENCE_PALETTE.attention[0]).toBe(1);
    expect(JARVIS_PRESENCE_PALETTE.error[0]).toBeGreaterThan(JARVIS_PRESENCE_PALETTE.error[1]);
    expect(JARVIS_PRESENCE_MODE_LABELS.idle).toBe("Standby");
    expect(JARVIS_PRESENCE_MODE_LABELS.attention).toBe("Attention");
  });

  it("projects truthful manager and voice state into presence modes", () => {
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: null,
        error: null,
        nativeVoiceState: null,
      }),
    ).toBe("idle");
    expect(
      jarvisPresenceMode({
        listening: true,
        submitting: true,
        activeTaskState: "running",
        error: null,
        nativeVoiceState: { status: "ready", native: true },
      }),
    ).toBe("listening");
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: true,
        activeTaskState: null,
        error: null,
        nativeVoiceState: { status: "ready", native: true },
      }),
    ).toBe("working");
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: "running",
        error: null,
        nativeVoiceState: { status: "speaking", native: true },
      }),
    ).toBe("speaking");
    for (const state of ["waiting-for-input", "waiting-for-approval"] as const) {
      expect(
        jarvisPresenceMode({
          listening: false,
          submitting: false,
          activeTaskState: state,
          error: null,
          nativeVoiceState: { status: "ready", native: true },
        }),
      ).toBe("attention");
    }
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: "running",
        error: "Native voice failed",
        nativeVoiceState: { status: "speaking", native: true },
      }),
    ).toBe("error");
    const completed = "ready" as const;
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: completed,
        error: null,
        nativeVoiceState: { status: "ready", native: true },
      }),
    ).toBe("idle");
  });

  it("animates only a bounded visible burst and cancels its pending frame", () => {
    const queued = new Map<number, (timestamp: number) => void>();
    let nextHandle = 0;
    const cancelled: number[] = [];
    const scheduler: JarvisPresenceFrameScheduler = {
      request: (callback) => {
        const handle = ++nextHandle;
        queued.set(handle, callback);
        return handle;
      },
      cancel: (handle) => {
        cancelled.push(handle);
        queued.delete(handle);
      },
    };
    const progress: number[] = [];
    const stop = startJarvisPresenceBurst({
      mode: "listening",
      visible: true,
      reducedMotion: false,
      scheduler,
      now: () => 0,
      durationMs: 100,
      onProgress: (value) => progress.push(value),
    });

    expect(queued.size).toBe(1);
    queued.get(1)!(50);
    queued.delete(1);
    expect(progress).toEqual([0.5]);
    expect(queued.size).toBe(1);
    stop();
    expect(cancelled).toEqual([2]);
    expect(queued.size).toBe(0);

    const complete = startJarvisPresenceBurst({
      mode: "listening",
      visible: true,
      reducedMotion: false,
      scheduler,
      now: () => 0,
      durationMs: 100,
      onProgress: (value) => progress.push(value),
    });
    queued.get(3)!(100);
    queued.delete(3);
    expect(progress).toEqual([0.5, 1]);
    expect(queued.size).toBe(0);
    complete();
    expect(cancelled).toEqual([2]);
  });

  it("does not schedule hidden, idle, or reduced-motion animation", () => {
    let requests = 0;
    const scheduler: JarvisPresenceFrameScheduler = {
      request: () => {
        requests += 1;
        return requests;
      },
      cancel: () => undefined,
    };
    for (const input of [
      { visible: false, reducedMotion: false },
      { visible: true, reducedMotion: true },
      { visible: true, reducedMotion: false },
    ]) {
      const stop = startJarvisPresenceBurst({
        ...input,
        mode: input.visible && !input.reducedMotion ? "idle" : "working",
        scheduler,
        onProgress: () => undefined,
      });
      stop();
    }
    expect(requests).toBe(0);
  });
});
