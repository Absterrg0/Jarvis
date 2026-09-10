import { describe, expect, it } from "vite-plus/test";

import {
  JARVIS_PRESENCE_MODES,
  JARVIS_PRESENCE_PALETTE,
  JARVIS_PRESENCE_SHADER_MOTION,
  JARVIS_PRESENCE_FRAGMENT_SHADER,
  JARVIS_PRESENCE_VERTEX_SHADER,
  createJarvisPresenceLifecycle,
} from "./presence.ts";

describe("Jarvis presence visual core", () => {
  it("exposes one semantic palette and transparent flowing-ribbon shader", () => {
    expect(JARVIS_PRESENCE_MODES).toEqual([
      "idle",
      "listening",
      "working",
      "speaking",
      "attention",
      "error",
    ]);
    expect(Object.keys(JARVIS_PRESENCE_PALETTE)).toEqual([...JARVIS_PRESENCE_MODES]);
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).toContain("u_time");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).toContain("u_progress");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).toContain("u_resolution");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).toContain("float fbm");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).toContain("float strand");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).toContain("upperCenter");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).toContain("middleCenter");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).toContain("lowerCenter");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).toContain("transparent between strands");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).toContain("never a radial disc mask");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).not.toContain("aperture");
    expect(JARVIS_PRESENCE_FRAGMENT_SHADER).not.toContain("length(p)");
    expect(JARVIS_PRESENCE_VERTEX_SHADER).toContain("a_position");
    expect(JARVIS_PRESENCE_SHADER_MOTION.frameIntervalMs).toBeGreaterThanOrEqual(30);
    expect(JARVIS_PRESENCE_SHADER_MOTION.maxFrames).toBeGreaterThan(0);
  });

  it("runs only a bounded visible active burst and cancels on state changes", () => {
    const queued = new Map<number, (timestamp: number) => void>();
    const cancelled: number[] = [];
    let nextHandle = 0;
    const draws: Array<{ progress: number; timestamp: number }> = [];
    const lifecycle = createJarvisPresenceLifecycle({
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
    const lifecycle = createJarvisPresenceLifecycle({
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
    const lifecycle = createJarvisPresenceLifecycle({
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
