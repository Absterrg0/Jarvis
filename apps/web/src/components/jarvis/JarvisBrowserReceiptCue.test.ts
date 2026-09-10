import { describe, expect, it, vi } from "vite-plus/test";

import { playJarvisBrowserReceiptCue } from "./JarvisBrowserReceiptCue";

describe("Jarvis browser receipt cue", () => {
  it("plays a short local blip without TTS, network, or loops", () => {
    const stop = vi.fn();
    const start = vi.fn();
    const connect = vi.fn();
    const speak = vi.fn();
    vi.stubGlobal("window", {
      speechSynthesis: { speak },
    } as never);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as never);
    playJarvisBrowserReceiptCue({
      createContext: () =>
        ({
          resume: vi.fn(),
          createOscillator: () => ({ type: "", frequency: { value: 0 }, connect, start, stop }),
          createGain: () => ({
            gain: {
              value: 0,
              setValueAtTime: vi.fn(),
              exponentialRampToValueAtTime: vi.fn(),
            },
            connect,
          }),
          destination: {},
          currentTime: 0,
          close: vi.fn(),
        }) as never,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(speak).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("stays silent when audio is unavailable instead of failing the release", () => {
    expect(() => playJarvisBrowserReceiptCue({ createContext: () => null })).not.toThrow();
    expect(() =>
      playJarvisBrowserReceiptCue({
        createContext: () => {
          throw new Error("no audio");
        },
      }),
    ).not.toThrow();
    vi.stubGlobal("window", undefined as never);
    expect(() => playJarvisBrowserReceiptCue()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
