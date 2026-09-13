import { describe, expect, it } from "vite-plus/test";

import {
  CIRCE_PRESENCE_MODES,
  CIRCE_PRESENCE_PALETTE,
  CIRCE_PRESENCE_SHADER_MOTION,
  CIRCE_PRESENCE_FRAGMENT_SHADER,
  CIRCE_PRESENCE_VERTEX_SHADER,
  createCircePresenceLifecycle,
} from "./presence.ts";

describe("Circe presence visual core", () => {
  it("exposes one semantic palette and transparent flowing-ribbon shader", () => {
    expect(CIRCE_PRESENCE_MODES).toEqual([
      "idle",
      "listening",
      "working",
      "speaking",
      "attention",
      "error",
    ]);
    expect(Object.keys(CIRCE_PRESENCE_PALETTE)).toEqual([...CIRCE_PRESENCE_MODES]);
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).toContain("u_time");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).toContain("u_progress");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).toContain("u_resolution");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).toContain("float fbm");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).toContain("float strand");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).toContain("upperCenter");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).toContain("middleCenter");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).toContain("lowerCenter");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).toContain("transparent between strands");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).toContain("never a radial disc mask");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).not.toContain("aperture");
    expect(CIRCE_PRESENCE_FRAGMENT_SHADER).not.toContain("length(p)");
    expect(CIRCE_PRESENCE_VERTEX_SHADER).toContain("a_position");
    expect(CIRCE_PRESENCE_SHADER_MOTION.frameIntervalMs).toBeGreaterThanOrEqual(30);
    expect(CIRCE_PRESENCE_SHADER_MOTION.maxFrames).toBeGreaterThan(0);
  });

  it("runs only a bounded visible active burst and cancels on state changes", () => {
    const queued = new Map<number, (timestamp: number) => void>();
    const cancelled: number[] = [];
    let nextHandle = 0;
    const draws: Array<{ progress: number; timestamp: number }> = [];
    const lifecycle = createCircePresenceLifecycle({
      requestFrame: (callback) => {
        const handle = ++nextHandle;
        queued.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => {
        cancelled.push(handle);
        queued.delete(handle);
      },
      draw: (progress, timestamp) => draws.push({ progress, timestamp }),
      visible: true,
      reducedMotion: false,
      now: () => 0,
    });

    lifecycle.setMode("idle");
    expect(queued.size).toBe(0);
    lifecycle.setMode("listening");
    expect(queued.size).toBe(1);
    queued.get(1)!(40);
    queued.delete(1);
    expect(draws).toEqual([{ progress: 0, timestamp: 40 }]);
    expect(queued.size).toBe(1);
    lifecycle.setMode("idle");
    expect(cancelled).toEqual([2]);
    expect(queued.size).toBe(0);
    lifecycle.dispose();
  });

  it("uses a custom clock consistently with RAF timestamps", () => {
    const queued = new Map<number, (timestamp: number) => void>();
    let nextHandle = 0;
    let currentTime = 1_000;
    const draws: Array<{ progress: number; timestamp: number }> = [];
    const lifecycle = createCircePresenceLifecycle({
      requestFrame: (callback) => {
        const handle = ++nextHandle;
        queued.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => queued.delete(handle),
      draw: (progress, timestamp) => draws.push({ progress, timestamp }),
      visible: true,
      reducedMotion: false,
      now: () => currentTime,
      frameIntervalMs: 0,
      burstDurationMs: 50,
    });

    lifecycle.setMode("speaking");
    queued.get(1)!(10_000);
    queued.delete(1);
    currentTime = 1_051;
    queued.get(2)!(10_016);

    expect(draws).toEqual([{ progress: 0, timestamp: 10_000 }]);
    lifecycle.dispose();
  });

  it("does not schedule reduced-motion or hidden surfaces", () => {
    let requests = 0;
    const lifecycle = createCircePresenceLifecycle({
      requestFrame: () => ++requests,
      cancelFrame: () => undefined,
      draw: () => undefined,
      visible: false,
      reducedMotion: false,
    });
    lifecycle.setMode("speaking");
    lifecycle.setVisible(true);
    lifecycle.setReducedMotion(true);
    expect(requests).toBe(1);
    lifecycle.dispose();
  });
});
