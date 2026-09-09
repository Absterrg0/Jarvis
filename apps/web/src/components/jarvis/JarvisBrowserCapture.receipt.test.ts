import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createJarvisBrowserCaptureController } from "./JarvisBrowserCapture";

function mockRecognition() {
  const sessions: Array<{
    onresult: ((event: never) => void) | null;
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
    onresult: ((event: never) => void) | null = null;
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

describe("Jarvis browser capture receipt", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires the receipt at release before the finalized transcript emits", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    const order: string[] = [];
    const controller = createJarvisBrowserCaptureController({
      onTranscript: () => order.push("transcript"),
      onError: () => order.push("error"),
      playReceiptCue: () => order.push("receipt"),
    });
    expect(controller.start("capture-receipt")).toBe(true);
    sessions[0]?.onresult?.(finalResult("hello") as never);
    controller.release();
    // Receipt lands synchronously at release, before onend finalization.
    expect(order).toEqual(["receipt"]);
    expect(sessions[0]?.stop).toHaveBeenCalledTimes(1);
    sessions[0]?.onend?.();
    expect(order).toEqual(["receipt", "transcript"]);
    controller.dispose();
  });

  it("never fires the receipt on cancel", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    const receipts: string[] = [];
    const seen: string[] = [];
    const controller = createJarvisBrowserCaptureController({
      onTranscript: (event) => seen.push(event.transcript),
      playReceiptCue: () => receipts.push("receipt"),
    });
    expect(controller.start("capture-cancel")).toBe(true);
    sessions[0]?.onresult?.(finalResult("hello") as never);
    controller.cancel();
    sessions[0]?.onend?.();
    expect(receipts).toEqual([]);
    expect(seen).toEqual([]);
    controller.dispose();
  });

  it("still reports an empty hold instead of going silent", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    const order: string[] = [];
    const errors: string[] = [];
    const controller = createJarvisBrowserCaptureController({
      onTranscript: () => order.push("transcript"),
      onError: (message) => {
        order.push("error");
        errors.push(message);
      },
      playReceiptCue: () => order.push("receipt"),
    });
    expect(controller.start("capture-empty")).toBe(true);
    controller.release();
    expect(order).toEqual(["receipt"]);
    sessions[0]?.onend?.();
    expect(order).toEqual(["receipt", "error"]);
    expect(errors).toEqual(["No speech was detected."]);
    controller.dispose();
  });

  it("keeps the release receipt when recognition later errors", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    const order: string[] = [];
    const controller = createJarvisBrowserCaptureController({
      onTranscript: () => order.push("transcript"),
      onError: () => order.push("error"),
      playReceiptCue: () => order.push("receipt"),
    });
    controller.start("capture-fail");
    controller.release();
    sessions[0]?.onerror?.({ error: "not-allowed" });
    expect(order).toEqual(["receipt", "error"]);
    controller.dispose();
  });

  it("fires the receipt once even when release is retried", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    let receipts = 0;
    const controller = createJarvisBrowserCaptureController({
      onTranscript: () => undefined,
      playReceiptCue: () => {
        receipts += 1;
      },
    });
    controller.start("capture-once");
    controller.release();
    controller.release();
    expect(receipts).toBe(1);
    sessions[0]?.onend?.();
    controller.dispose();
  });

  it("still releases when the receipt player is missing", () => {
    const { sessions, Constructor } = mockRecognition();
    vi.stubGlobal("window", { SpeechRecognition: Constructor });
    vi.stubGlobal("navigator", { language: "en-US" });
    const seen: string[] = [];
    const controller = createJarvisBrowserCaptureController({
      onTranscript: (event) => seen.push(event.transcript),
      playReceiptCue: () => {
        throw new Error("no audio");
      },
    });
    expect(controller.start("capture-no-audio")).toBe(true);
    sessions[0]?.onresult?.(finalResult("hello") as never);
    expect(() => controller.release()).not.toThrow();
    sessions[0]?.onend?.();
    expect(seen).toEqual(["hello"]);
    controller.dispose();
  });
});
