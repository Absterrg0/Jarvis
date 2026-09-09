import * as Haptics from "expo-haptics";

/**
 * Immediate capture receipt for mobile hold-to-talk.
 *
 * Local haptic only: never uploads, never synthesizes remotely, never speaks.
 * Callers fire it synchronously from finishCapture before local or remote
 * transcription starts, so the cue lands before ASR and provider dispatch.
 * Failures stay silent so transcription and its truthful Heard/empty message
 * still land. The visual phase (transcribing) is the independent UI receipt.
 */
export function playMobileVoiceReceipt(): void {
  try {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  } catch {
    // A missing haptics module must not block the release.
  }
}
