/**
 * Static contract tests for the Android on-device adapter.
 *
 * The native `JarvisLocalAsr` module is mocked. No microphone, recognizer, or
 * network runs here. Physical-device verification (pack download, offline
 * behavior, locale coverage) is pending and documented in
 * `voiceTranscription.android.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

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

import {
  getLocalLiveVoiceRecognizer,
  getLocalVoiceTranscriber,
} from "./voiceTranscription.android";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isAvailable.mockReturnValue(true);
  mocks.getModule.mockReturnValue({
    startListening: mocks.startListening,
    stopListening: mocks.stopListening,
    cancel: mocks.cancel,
  });
  mocks.startListening.mockResolvedValue(undefined);
  mocks.stopListening.mockResolvedValue("  hej världen  ");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLocalLiveVoiceRecognizer (android)", () => {
  it("reports unavailable when on-device support is missing", () => {
    mocks.isAvailable.mockReturnValue(false);
    expect(getLocalLiveVoiceRecognizer()).toBeNull();
  });

  it("reports unavailable when the native module is missing", () => {
    mocks.getModule.mockReturnValue(null);
    mocks.isAvailable.mockReturnValue(false);
    expect(getLocalLiveVoiceRecognizer()).toBeNull();
  });

  it("exposes no file transcriber on the live path", () => {
    expect(getLocalVoiceTranscriber()).toBeNull();
  });

  it("snapshots the device locale at selection time", async () => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
    const deviceLocale = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolvedOptions, locale: "sv-FI" });
    const recognizer = getLocalLiveVoiceRecognizer()!;
    const options = { signal: new AbortController().signal };

    deviceLocale.mockReturnValue({ ...resolvedOptions, locale: "de-DE" });
    const session = await recognizer.prepare(options);
    deviceLocale.mockReturnValue({ ...resolvedOptions, locale: "en-US" });

    await expect(session.finish(options)).resolves.toBe("hej världen");
    expect(mocks.startListening).toHaveBeenCalledWith("sv-FI");
    expect(session.locale).toBe("sv-FI");
    expect(session.finish.length).toBe(1);
  });

  it("never falls back when on-device support disappears before prepare", async () => {
    const recognizer = getLocalLiveVoiceRecognizer()!;
    mocks.isAvailable.mockReturnValue(false);
    mocks.getModule.mockReturnValue(null);
    await expect(
      recognizer.prepare({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(mocks.startListening).not.toHaveBeenCalled();
  });

  it("maps unsupported locales without retrying online", async () => {
    mocks.startListening.mockRejectedValue({ code: "UNSUPPORTED_LOCALE" });
    const recognizer = getLocalLiveVoiceRecognizer()!;
    const error = await recognizer
      .prepare({ signal: new AbortController().signal })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "unsupported-locale" });
  });

  it("cancels the live session when the operation aborts before finish", async () => {
    const recognizer = getLocalLiveVoiceRecognizer()!;
    const controller = new AbortController();
    const session = await recognizer.prepare({ signal: controller.signal });
    controller.abort();
    const error = await session
      .finish({ signal: controller.signal })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(mocks.cancel).toHaveBeenCalled();
    expect(mocks.stopListening).not.toHaveBeenCalled();
  });

  it("maps a native CANCELLED stop to cancelled without a stale transcript", async () => {
    mocks.stopListening.mockRejectedValueOnce({ code: "CANCELLED" });
    const recognizer = getLocalLiveVoiceRecognizer()!;
    const session = await recognizer.prepare({ signal: new AbortController().signal });
    const error = await session
      .finish({ signal: new AbortController().signal })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "cancelled" });
  });

  it("rejects a second finish without driving the recognizer again", async () => {
    const recognizer = getLocalLiveVoiceRecognizer()!;
    const options = { signal: new AbortController().signal };
    const session = await recognizer.prepare(options);
    await expect(session.finish(options)).resolves.toBe("hej världen");
    const error = await session.finish(options).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "transcription-failed" });
    expect(mocks.stopListening).toHaveBeenCalledTimes(1);
  });

  it("does not cancel after the session already settled", async () => {
    const recognizer = getLocalLiveVoiceRecognizer()!;
    const controller = new AbortController();
    const session = await recognizer.prepare({ signal: controller.signal });
    await session.finish({ signal: controller.signal });
    mocks.cancel.mockClear();
    controller.abort();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
