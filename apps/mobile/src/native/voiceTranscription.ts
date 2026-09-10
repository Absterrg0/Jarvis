import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import type { LocalLiveVoiceRecognizer } from "./voiceTranscription.android";

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return null;
}

export function getLocalLiveVoiceRecognizer(): LocalLiveVoiceRecognizer | null {
  return null;
}
