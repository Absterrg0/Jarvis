import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

import { getJarvisLocalAsrModule, isJarvisLocalAsrAvailable } from "./jarvisLocalAsr";

function getDeviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function wrapError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  if (cause instanceof VoiceTranscriptionError) {
    return cause;
  }
  return new VoiceTranscriptionError(code, message, { cause });
}

function getNativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/** Genuine live on-device session. Finish takes only options, never a file URI. */
export type PreparedLocalLiveVoiceSession = {
  readonly locale: string;
  readonly finish: (options: VoiceTranscriptionOptions) => Promise<string>;
};

export type LocalLiveVoiceRecognizer = {
  readonly prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedLocalLiveVoiceSession>;
};

/**
 * Android on-device transcription through the narrow `JarvisLocalAsr` module,
 * which uses only `SpeechRecognizer.createOnDeviceSpeechRecognizer`.
 *
 * Support checks run before every operation: unavailable recognition or a
 * missing on-device pack means no recognizer, never a silent online
 * fallback. The live session owns the mic from prepare until finish; there is
 * no file transcription API on this path and no URI sentinel. First use may
 * download the on-device pack. Offline operation for a language is expected
 * after that download, but no offline behavior is claimed beyond what the
 * framework reports. Physical-device verification is pending (no Android
 * device in CI); static tests mock the native module.
 */
export function getLocalLiveVoiceRecognizer(): LocalLiveVoiceRecognizer | null {
  if (!isJarvisLocalAsrAvailable()) return null;
  const locale = getDeviceLocale();
  return { prepare: (options) => prepareLiveRecognition(locale, options) };
}

/**
 * Android owns no file transcription path. The shared file transcriber stays
 * null here so callers cannot pass a fake URI; iOS provides the real file
 * transcriber through its own module.
 */
export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return null;
}

async function prepareLiveRecognition(
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedLocalLiveVoiceSession> {
  throwIfVoiceTranscriptionAborted(signal);
  const module = getJarvisLocalAsrModule();
  if (!module || !isJarvisLocalAsrAvailable()) {
    throw new VoiceTranscriptionError(
      "unavailable",
      "On-device speech recognition is not available on this device.",
    );
  }
  try {
    await module.startListening(locale);
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (getNativeErrorCode(error) === "UNSUPPORTED_LOCALE") {
      throw new VoiceTranscriptionError(
        "unsupported-locale",
        "On-device recognition does not support this device language.",
        { cause: error },
      );
    }
    throw wrapError(
      "preparation-failed",
      "On-device recognition could not start for this language.",
      error,
    );
  }
  if (signal.aborted) {
    try {
      module.cancel();
    } catch {
      // Native cancel is best-effort; the abort error below owns the result.
    }
    throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
  }
  let settled = false;
  const cancel = (): void => {
    if (settled) return;
    settled = true;
    try {
      module.cancel();
    } catch {
      // Native cancel is best-effort; the abort error below owns the result.
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  return {
    locale,
    finish: async (options) => {
      if (settled) {
        throwIfVoiceTranscriptionAborted(options.signal);
        throwIfVoiceTranscriptionAborted(signal);
        throw new VoiceTranscriptionError(
          "transcription-failed",
          "Live recognition session already finished.",
        );
      }
      // An abort arriving mid-stop must reach the native recognizer: without
      // this listener stopListening hangs until the recognizer resolves on
      // its own, past the caller's cancellation.
      const abortStop = (): void => {
        try {
          module.cancel();
        } catch {
          // Native cancel is best-effort; the abort error below owns the result.
        }
      };
      if (options.signal?.aborted) abortStop();
      options.signal?.addEventListener("abort", abortStop, { once: true });
      try {
        throwIfVoiceTranscriptionAborted(options.signal);
        throwIfVoiceTranscriptionAborted(signal);
        const transcript = await module.stopListening();
        throwIfVoiceTranscriptionAborted(options.signal);
        throwIfVoiceTranscriptionAborted(signal);
        return transcript.trim();
      } catch (error) {
        throwIfVoiceTranscriptionAborted(options.signal);
        throwIfVoiceTranscriptionAborted(signal);
        if (getNativeErrorCode(error) === "CANCELLED") {
          throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
        }
        if (getNativeErrorCode(error) === "UNSUPPORTED_LOCALE") {
          throw new VoiceTranscriptionError(
            "unsupported-locale",
            "On-device recognition does not support this device language.",
            { cause: error },
          );
        }
        throw wrapError("transcription-failed", "On-device recognition failed.", error);
      } finally {
        settled = true;
        options.signal?.removeEventListener("abort", abortStop);
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}
