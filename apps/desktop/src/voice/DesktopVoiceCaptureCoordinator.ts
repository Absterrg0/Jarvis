import {
  isVoiceCaptureErrorCode,
  type VoiceCaptureErrorCode,
} from "@t3tools/jarvis-native-voice/desktop-native-voice";

export type DesktopVoiceCaptureSettlement =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string; readonly code?: VoiceCaptureErrorCode };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errorCode(cause: unknown): VoiceCaptureErrorCode | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return isVoiceCaptureErrorCode(cause.code) ? cause.code : undefined;
}

/**
 * Delivers a native capture result only while that exact capture is active.
 * A cancelled capture may settle after a replacement starts; its result must
 * not clear the replacement's deadline or move the worker back to ready.
 */
export function bindDesktopVoiceCaptureResult<T>(input: {
  readonly capture: T;
  readonly result: Promise<string>;
  readonly isActive: (capture: T) => boolean;
  readonly onSettled: (settlement: DesktopVoiceCaptureSettlement) => void;
}): void {
  void input.result.then(
    (text) => {
      if (input.isActive(input.capture)) input.onSettled({ ok: true, text });
    },
    (cause) => {
      if (input.isActive(input.capture)) {
        const code = errorCode(cause);
        input.onSettled({
          ok: false,
          message: errorMessage(cause),
          ...(code === undefined ? {} : { code }),
        });
      }
    },
  );
}
