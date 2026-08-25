import { describe, expect, it, vi } from "vite-plus/test";

import { createJarvisNativeCaptureController } from "./JarvisNativeCapture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Jarvis native capture controller", () => {
  it("queues a quick release until an accepted start resolves", async () => {
    const start = deferred<{ accepted: boolean }>();
    const voice = {
      startCapture: vi.fn(() => start.promise),
      releaseCapture: vi.fn(async () => ({ accepted: true })),
      cancelCapture: vi.fn(async () => ({ accepted: true })),
    };
    const controller = createJarvisNativeCaptureController({
      voice,
      onPhase: vi.fn(),
      onStartFailure: vi.fn(),
      onReleaseFailure: vi.fn(),
    });

    controller.start();
    controller.release();
    expect(voice.releaseCapture).not.toHaveBeenCalled();
    start.resolve({ accepted: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(voice.startCapture).toHaveBeenCalledTimes(1);
    expect(voice.releaseCapture).toHaveBeenCalledTimes(1);
    expect(controller.phase()).toBe("idle");
  });

  it("drops a queued release when start is rejected", async () => {
    const start = deferred<{ accepted: boolean }>();
    const onStartFailure = vi.fn();
    const voice = {
      startCapture: vi.fn(() => start.promise),
      releaseCapture: vi.fn(async () => ({ accepted: true })),
      cancelCapture: vi.fn(async () => ({ accepted: true })),
    };
    const controller = createJarvisNativeCaptureController({
      voice,
      onPhase: vi.fn(),
      onStartFailure,
      onReleaseFailure: vi.fn(),
    });

    controller.start();
    controller.release();
    start.resolve({ accepted: false });
    await Promise.resolve();
    expect(onStartFailure).toHaveBeenCalledTimes(1);
    expect(voice.releaseCapture).not.toHaveBeenCalled();
    expect(controller.phase()).toBe("idle");
  });

  it("keeps a pending start alive when the worker reports its initial ready state", async () => {
    const start = deferred<{ accepted: boolean }>();
    const voice = {
      startCapture: vi.fn(() => start.promise),
      releaseCapture: vi.fn(async () => ({ accepted: true })),
      cancelCapture: vi.fn(async () => ({ accepted: true })),
    };
    const controller = createJarvisNativeCaptureController({
      voice,
      onPhase: vi.fn(),
      onStartFailure: vi.fn(),
      onReleaseFailure: vi.fn(),
    });

    controller.start();
    controller.markWorkerReady();
    start.resolve({ accepted: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.phase()).toBe("capturing");
    expect(voice.cancelCapture).not.toHaveBeenCalled();
  });

  it("ignores repeated starts/releases and cancels stale accepted starts", async () => {
    const start = deferred<{ accepted: boolean }>();
    const voice = {
      startCapture: vi.fn(() => start.promise),
      releaseCapture: vi.fn(async () => ({ accepted: true })),
      cancelCapture: vi.fn(async () => ({ accepted: true })),
    };
    const controller = createJarvisNativeCaptureController({
      voice,
      onPhase: vi.fn(),
      onStartFailure: vi.fn(),
      onReleaseFailure: vi.fn(),
    });

    controller.start();
    controller.start();
    controller.cancel();
    controller.release();
    start.resolve({ accepted: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(voice.startCapture).toHaveBeenCalledTimes(1);
    expect(voice.releaseCapture).not.toHaveBeenCalled();
    expect(voice.cancelCapture).toHaveBeenCalledTimes(2);
  });
});
