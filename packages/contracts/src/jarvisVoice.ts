import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A complete push-to-talk utterance may last at most fifteen seconds. */
export const JARVIS_VOICE_MAX_DURATION_MS = 15_000;
export function jarvisVoiceMaxPcmBytes(sampleRate: number, channels: number): number {
  return Math.floor((JARVIS_VOICE_MAX_DURATION_MS / 1_000) * sampleRate * channels * 2);
}
/** Upper bound for the encoded utterance sent over the authenticated RPC. */
export const JARVIS_VOICE_MAX_PCM_BYTES = jarvisVoiceMaxPcmBytes(48_000, 2);
/** Base64 expands binary data by four bytes for every three input bytes. */
export const JARVIS_VOICE_MAX_PCM_BASE64_LENGTH = Math.ceil(JARVIS_VOICE_MAX_PCM_BYTES / 3) * 4;
export const JARVIS_VOICE_MAX_TTS_TEXT_LENGTH = 2_000;
export const JARVIS_VOICE_MAX_SYNTHESIS_PCM_BYTES = 8_000_000;
export const JARVIS_VOICE_MAX_SYNTHESIS_PCM_BASE64_LENGTH =
  Math.ceil(JARVIS_VOICE_MAX_SYNTHESIS_PCM_BYTES / 3) * 4;
export const JARVIS_VOICE_MAX_WAV_BYTES = JARVIS_VOICE_MAX_SYNTHESIS_PCM_BYTES + 44;
export const JARVIS_VOICE_MAX_WAV_BASE64_LENGTH = Math.ceil(JARVIS_VOICE_MAX_WAV_BYTES / 3) * 4;

const Base64 = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
);

const JarvisVoiceEncodedAudio = Base64.check(
  Schema.isMaxLength(JARVIS_VOICE_MAX_PCM_BASE64_LENGTH),
);
const JarvisVoicePcmInput = Schema.Struct({
  format: Schema.Literal("pcm-s16le"),
  audioBase64: JarvisVoiceEncodedAudio,
  sampleRate: PositiveInt.check(Schema.isBetween({ minimum: 8_000, maximum: 48_000 })),
  channels: PositiveInt.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
});
export const JarvisVoiceTranscribeInput = JarvisVoicePcmInput;
export type JarvisVoiceTranscribeInput = typeof JarvisVoiceTranscribeInput.Type;

export const JarvisVoiceTranscribeResult = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
});
export type JarvisVoiceTranscribeResult = typeof JarvisVoiceTranscribeResult.Type;

export const JarvisVoiceSynthesizeInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(JARVIS_VOICE_MAX_TTS_TEXT_LENGTH)),
});
export type JarvisVoiceSynthesizeInput = typeof JarvisVoiceSynthesizeInput.Type;

export const JarvisVoiceSynthesizeResult = Schema.Struct({
  wavBase64: Base64.check(Schema.isMaxLength(JARVIS_VOICE_MAX_WAV_BASE64_LENGTH)),
});
export type JarvisVoiceSynthesizeResult = typeof JarvisVoiceSynthesizeResult.Type;

export const JarvisVoiceOperation = Schema.Literals(["transcribe", "synthesize"]);
export type JarvisVoiceOperation = typeof JarvisVoiceOperation.Type;

export class JarvisVoiceInvalidInputError extends Schema.TaggedErrorClass<JarvisVoiceInvalidInputError>()(
  "JarvisVoiceInvalidInputError",
  {
    operation: JarvisVoiceOperation,
    message: Schema.String,
  },
) {}

export class JarvisVoiceUnavailableError extends Schema.TaggedErrorClass<JarvisVoiceUnavailableError>()(
  "JarvisVoiceUnavailableError",
  {
    operation: JarvisVoiceOperation,
    message: Schema.String,
  },
) {}

export class JarvisVoiceRuntimeError extends Schema.TaggedErrorClass<JarvisVoiceRuntimeError>()(
  "JarvisVoiceRuntimeError",
  {
    operation: JarvisVoiceOperation,
    message: Schema.String,
  },
) {}

export type JarvisVoiceError =
  | JarvisVoiceInvalidInputError
  | JarvisVoiceUnavailableError
  | JarvisVoiceRuntimeError;

/** Return the number of decoded bytes represented by a valid base64 string. */
export function jarvisVoiceBase64ByteLength(value: string): number | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
