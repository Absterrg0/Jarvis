export const voiceCaptureErrorCodes = [
  "permission-denied",
  "no-input-device",
  "no-audio-frames",
  "transcription-failed",
  "cancelled",
  "capture-timeout",
] as const;

export type VoiceCaptureErrorCode = (typeof voiceCaptureErrorCodes)[number];

export type VoiceCaptureError = Error & { readonly code: VoiceCaptureErrorCode };

export function isVoiceCaptureErrorCode(value: unknown): value is VoiceCaptureErrorCode {
  return typeof value === "string" && (voiceCaptureErrorCodes as readonly string[]).includes(value);
}

export function classifyVoiceCaptureError(cause: unknown): VoiceCaptureErrorCode {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { readonly code?: unknown }).code;
    if (isVoiceCaptureErrorCode(code)) return code;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/cancel(?:led|ed)|abort|interrupted|stopped/iu.test(message)) return "cancelled";
  if (/timed?\s*out|timeout/iu.test(message)) return "capture-timeout";
  if (/permission|access denied|not authorized|EACCES|EPERM|privacy/iu.test(message)) {
    return "permission-denied";
  }
  if (/no audio|no frames|silent|didn['’]?t receive audio|didn['’]?t hear/iu.test(message)) {
    return "no-audio-frames";
  }
  if (
    /no (?:input|microphone)|input device|device not found|microphone unavailable/iu.test(message)
  ) {
    return "no-input-device";
  }
  return "transcription-failed";
}

export function createVoiceCaptureError(
  code: VoiceCaptureErrorCode,
  message: string,
  cause?: unknown,
): VoiceCaptureError {
  const error = new Error(message) as VoiceCaptureError;
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
}
