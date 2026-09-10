import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createJarvisBrowserCaptureController,
  isJarvisBrowserSpeechSupported,
} from "./JarvisBrowserCapture";

function mockRecognition() {
  const sessions: Array<{
    onresult: ((event: any) => void) | null;
    onerror: ((event: { error?: string }) => void) | null;
    onend: (() => void) | null;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  }> = [];
  class FakeRecognition {
    lang = "";
    interimResults = false;
    maxAlternatives = 0;
    continuous = false;
    onresult: ((event: any) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
      sessions.push(this as never);
    }
  }
  return { sessions, Constructor: FakeRecognition as never };
}

function finalResult(text: string) {
  return {
    results: { length: 1, 0: { isFinal: true, 0: { transcript: text } } } as never,
    resultIndex: 0,
  };
}

describe("Jarvis browser capture", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unsupported when neither SpeechRecognition nor webkit prefix exists", () => {
    vi.stubGlobal("window", {});
    expect(isJarvisBrowserSpeechSupported()).toBe(false);
    const controller = createJarvisBrowserCaptureController({ onTranscript: () => undefined });
    expect(controller.supported).toBe(false);
    expect(controller.phase()).toBe("unsupported");
    expect(controller.start()).toBe(false);
    controller.dispose();
  });

  it("uses webkit prefix when standard recognition is missing", () => {
    const { Constructor } = mockRecognition();
    vi.stubGlobal("window", { webkitSpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(isJarvisBrowserSpeechSupported()).toBe(true);
    const controller = createJarvisBrowserCaptureController({
      onTranscript: () => undefined,
    });
    expect(controller.start("capture-1")).toBe(true);
    expect(controller.phase()).toBe("listening");
    controller.dispose();
  });

  it("buffers finals and emits once on explicit release", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    const seen: string[] = [];
    const controller = createJarvisBrowserCaptureController({
      onTranscript: (event) => seen.push(`${event.captureId}:${event.transcript}`),
    });
    expect(controller.start("capture-1")).toBe(true);
    sessions[0]?.onresult?.(finalResult("hello"));
    sessions[0]?.onresult?.(finalResult("world"));
    // Nothing dispatches before the explicit release.
    expect(seen).toEqual([]);
    controller.release();
    expect(sessions[0]?.stop).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    sessions[0]?.onend?.();
    expect(seen).toEqual(["capture-1:hello world"]);
    expect(controller.phase()).toBe("idle");
    controller.dispose();
  });

  it("drops the buffer on cancel even after an early final", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    const seen: string[] = [];
    const controller = createJarvisBrowserCaptureController({
      onTranscript: (event) => seen.push(event.transcript),
    });
    expect(controller.start("capture-1")).toBe(true);
    expect(controller.start("capture-2")).toBe(false);
    sessions[0]?.onresult?.(finalResult("hello"));
    controller.cancel();
    // The early final never dispatches once cancelled.
    sessions[0]?.onend?.();
    expect(seen).toEqual([]);
    expect(controller.phase()).toBe("idle");
    // Late results from the cancelled generation stay dropped.
    sessions[0]?.onresult?.(finalResult("late"));
    expect(seen).toEqual([]);
    expect(controller.start("capture-2")).toBe(true);
    sessions[1]?.onresult?.(finalResult("  hello world  "));
    controller.release();
    sessions[1]?.onend?.();
    expect(seen).toEqual(["hello world"]);
    controller.dispose();
    sessions[1]?.onresult?.(finalResult("late"));
    expect(seen).toEqual(["hello world"]);
  });

  it("restarts the session on auto-end mid-hold and keeps one emission", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    const seen: string[] = [];
    const controller = createJarvisBrowserCaptureController({
      onTranscript: (event) => seen.push(`${event.captureId}:${event.transcript}`),
    });
    expect(controller.start("capture-1")).toBe(true);
    sessions[0]?.onresult?.(finalResult("first"));
    // Recognition auto-ends on silence while still held: a new segment
    // continues under the same capture instead of emitting early.
    sessions[0]?.onend?.();
    expect(seen).toEqual([]);
    expect(controller.phase()).toBe("listening");
    expect(sessions).toHaveLength(2);
    sessions[1]?.onresult?.(finalResult("second"));
    controller.release();
    sessions[1]?.onend?.();
    expect(seen).toEqual(["capture-1:first second"]);
    controller.dispose();
  });

  it("release stops the session and reports errors without stranding the phase", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    const errors: string[] = [];
    const phases: string[] = [];
    const controller = createJarvisBrowserCaptureController({
      onTranscript: () => undefined,
      onError: (message) => errors.push(message),
      onPhase: (phase) => phases.push(phase),
    });
    controller.start("capture-1");
    controller.release();
    expect(sessions[0]?.stop).toHaveBeenCalledTimes(1);
    sessions[0]?.onerror?.({ error: "not-allowed" });
    expect(errors).toEqual(["Microphone access was denied."]);
    expect(controller.phase()).toBe("idle");
    expect(phases).toContain("idle");
    controller.dispose();
  });

  it("reports every recognition failure as a user-facing sentence", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    const errors: string[] = [];
    const cases: Array<[string | undefined, string]> = [
      ["no-speech", "No speech was detected."],
      ["audio-capture", "No microphone input was detected."],
      ["service-not-allowed", "Microphone access was denied."],
      ["aborted", "Browser speech recognition failed."],
      [undefined, "Browser speech recognition failed."],
    ];
    for (const [code, expected] of cases) {
      const controller = createJarvisBrowserCaptureController({
        onTranscript: () => undefined,
        onError: (message) => errors.push(message),
      });
      controller.start(`capture-${code ?? "missing"}`);
      sessions[sessions.length - 1]?.onerror?.(code === undefined ? {} : { error: code });
      controller.dispose();
    }
    expect(errors).toEqual(cases.map(([, expected]) => expected));
  });
});
