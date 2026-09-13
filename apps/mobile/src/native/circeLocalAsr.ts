/**
 * Typed wrapper around the narrow `CirceLocalAsr` Expo module.
 *
 * Android only. iOS reports unavailable here; the real iOS path is
 * `@react-native-ai/apple` through `voiceTranscription.ios.ts`.
 * Returns null when the native module is missing (Expo Go, web, tests
 * without a mock) so callers treat local ASR as unavailable instead of
 * crashing. Physical-device verification is pending.
 */

export interface CirceLocalAsrModule {
  isRecognitionAvailable(): boolean;
  isOnDeviceRecognitionAvailable(): boolean;
  getSupport(): { readonly recognitionAvailable: boolean; readonly onDeviceAvailable: boolean };
  startListening(language: string): Promise<void>;
  stopListening(): Promise<string>;
  cancel(): void;
}

function loadModule(): CirceLocalAsrModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expo = require("expo") as {
      requireNativeModule?: <T>(name: string) => T;
    };
    if (typeof expo.requireNativeModule !== "function") return null;
    return expo.requireNativeModule<CirceLocalAsrModule>("CirceLocalAsr");
  } catch {
    return null;
  }
}

let cached: CirceLocalAsrModule | null | undefined;

export function getCirceLocalAsrModule(): CirceLocalAsrModule | null {
  if (cached === undefined) cached = loadModule();
  return cached;
}

/** Test seam: reset the cached module handle. */
export function resetCirceLocalAsrForTests(): void {
  cached = undefined;
}

export function isCirceLocalAsrAvailable(): boolean {
  const module = getCirceLocalAsrModule();
  if (!module) return false;
  try {
    return (
      module.isRecognitionAvailable() === true && module.isOnDeviceRecognitionAvailable() === true
    );
  } catch {
    return false;
  }
}
