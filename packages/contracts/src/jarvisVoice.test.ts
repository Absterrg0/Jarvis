import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  JARVIS_VOICE_MAX_PCM_BASE64_LENGTH,
  JARVIS_VOICE_MAX_SYNTHESIS_PCM_BYTES,
  JARVIS_VOICE_MAX_WAV_BYTES,
  JarvisVoiceSynthesizeInput,
  JarvisVoiceSynthesizeResult,
  JarvisVoiceTranscribeInput,
  jarvisVoiceBase64ByteLength,
  jarvisVoiceMaxPcmBytes,
} from "./jarvisVoice.ts";

const decodeTranscribe = Schema.decodeUnknownSync(JarvisVoiceTranscribeInput);
const decodeSynthesizeInput = Schema.decodeUnknownSync(JarvisVoiceSynthesizeInput);
const decodeSynthesizeResult = Schema.decodeUnknownSync(JarvisVoiceSynthesizeResult);

describe("Jarvis remote voice contracts", () => {
  it("accepts one complete signed-PCM mobile utterance", () => {
    expect(
      decodeTranscribe({
        format: "pcm-s16le",
        audioBase64: "AAAA",
        sampleRate: 16_000,
        channels: 1,
      }),
    ).toMatchObject({ format: "pcm-s16le", sampleRate: 16_000, channels: 1 });
  });

  it("rejects malformed or oversized encoded input", () => {
    expect(() =>
      decodeTranscribe({
        format: "pcm-s16le",
        audioBase64: "not base64",
        sampleRate: 16_000,
        channels: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeTranscribe({
        format: "pcm-s16le",
        audioBase64: "A".repeat(JARVIS_VOICE_MAX_PCM_BASE64_LENGTH + 1),
        sampleRate: 16_000,
        channels: 1,
      }),
    ).toThrow();
  });

  it("bounds TTS text and returns only WAV audio", () => {
    expect(decodeSynthesizeInput({ text: "  Say this once. " })).toEqual({
      text: "Say this once.",
    });
    expect(decodeSynthesizeResult({ wavBase64: "AAAA" })).toEqual({ wavBase64: "AAAA" });
    expect(JARVIS_VOICE_MAX_WAV_BYTES).toBe(JARVIS_VOICE_MAX_SYNTHESIS_PCM_BYTES + 44);
  });

  it("calculates decoded base64 bytes for server-side size checks", () => {
    expect(jarvisVoiceBase64ByteLength("AAAA")).toBe(3);
    expect(jarvisVoiceBase64ByteLength("AAA=")).toBe(2);
    expect(jarvisVoiceBase64ByteLength("AA==")).toBe(1);
    expect(jarvisVoiceBase64ByteLength("bad")).toBeNull();
  });

  it("derives the fifteen-second PCM limit from the actual audio format", () => {
    expect(jarvisVoiceMaxPcmBytes(16_000, 1)).toBe(480_000);
    expect(jarvisVoiceMaxPcmBytes(48_000, 2)).toBe(2_880_000);
  });
});
