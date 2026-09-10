/**
 * Negative regression test for the narrow genuine live-recognition seam.
 *
 * The Android live path must not reuse the file-transcriber signature with a
 * fake `local-asr://` URI sentinel. It exposes prepare/finish with no URI.
 * No microphone or recognizer runs here; the native module is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn<() => boolean>(),
  getModule: vi.fn<
    () => {
      startListening: (locale: string) => Promise<void>;
      stopListening: () => Promise<string>;
      cancel: () => void;
    } | null
  >(),
  startListening: vi.fn<(locale: string) => Promise<void>>(),
  stopListening: vi.fn<() => Promise<string>>(),
  cancel: vi.fn<() => void>(),
}));

vi.mock("./jarvisLocalAsr", () => ({
  getJarvisLocalAsrModule: mocks.getModule,
  isJarvisLocalAsrAvailable: mocks.isAvailable,
}));

import { getLocalLiveVoiceRecognizer } from "./voiceTranscription.android";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isAvailable.mockReturnValue(true);
  mocks.getModule.mockReturnValue({
    startListening: mocks.startListening,
    stopListening: mocks.stopListening,
    cancel: mocks.cancel,
  });
  mocks.startListening.mockResolvedValue(undefined);
  mocks.stopListening.mockResolvedValue("hej världen");
});

describe("genuine live-recognition seam", () => {
  it("prepares and finishes with no file URI argument", async () => {
    const recognizer = getLocalLiveVoiceRecognizer();
    expect(recognizer).not.toBeNull();
    const session = await recognizer!.prepare({ signal: new AbortController().signal });
    expect(session.locale.length).toBeGreaterThan(0);
    const text = await session.finish({ signal: new AbortController().signal });
    expect(text).toBe("hej världen");
    expect(mocks.startListening).toHaveBeenCalledTimes(1);
    expect(mocks.stopListening).toHaveBeenCalledTimes(1);
    // The live finish signature takes only options, never a URI sentinel.
    expect(session.finish.length).toBe(1);
  });

  it("holds cancellation until the native stop settles", async () => {
    let releaseStop!: (value: string) => void;
    const stopGate = new Promise<string>((resolve) => {
      releaseStop = resolve;
    });
    mocks.stopListening.mockReturnValueOnce(stopGate);
    const recognizer = getLocalLiveVoiceRecognizer()!;
    const controller = new AbortController();
    const session = await recognizer.prepare({ signal: controller.signal });
    const settled: unknown[] = [];
    const pending = session.finish({ signal: controller.signal }).then(
      (value) => settled.push(value),
      (error) => settled.push(error),
    );
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toHaveLength(0);
    expect(mocks.cancel).toHaveBeenCalled();
    releaseStop("late hello");
    await pending;
    // Abort during the live stop reports cancellation only after native settles.
    expect(settled).toHaveLength(1);
  });
});
