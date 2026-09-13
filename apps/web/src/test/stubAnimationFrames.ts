import { vi } from "vite-plus/test";

// Wait for worker shutdown before calling this cleanup, then restore globals.
export function stubAnimationFrames(): () => void {
  const frames = new Set<ReturnType<typeof setImmediate>>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const frame = setImmediate(() => {
      frames.delete(frame);
      callback(0);
    });
    frames.add(frame);
    return frame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: ReturnType<typeof setImmediate>) => {
    frames.delete(frame);
    clearImmediate(frame);
  });

  return () => {
    for (const frame of frames) clearImmediate(frame);
    frames.clear();
  };
}
