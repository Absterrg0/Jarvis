import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { encodePcmS16LeWav, makeLiveService } from "./JarvisVoiceCompute.ts";

describe("Jarvis voice compute", () => {
  it("sends whole signed-PCM utterances to the resident runtime", async () => {
    const calls: Array<{ audio: Uint8Array; sampleRate: number; channels: number }> = [];
    const service = await Effect.runPromise(
      makeLiveService({
        transcribe: async (input) => {
          calls.push(input);
          return "  start the tests  ";
        },
        synthesize: async () => ({ sampleRate: 24_000, channels: 1, pcm: Buffer.from([0, 0]) }),
      }),
    );

    await expect(
      Effect.runPromise(
        service.transcribe({
          format: "pcm-s16le",
          audioBase64: "AAABAA==",
          sampleRate: 16_000,
          channels: 1,
        }),
      ),
    ).resolves.toEqual({ text: "start the tests" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect([...call.audio]).toEqual([0, 0, 1, 0]);
    expect(call).toMatchObject({ sampleRate: 16_000, channels: 1 });
  });

  it("returns Kokoro PCM as a playable mono WAV", async () => {
    const service = await Effect.runPromise(
      makeLiveService({
        transcribe: async () => "unused",
        synthesize: async () => ({
          sampleRate: 24_000,
          channels: 1,
          pcm: Buffer.from([0x34, 0x12, 0xcc, 0xed]),
        }),
      }),
    );

    const result = await Effect.runPromise(service.synthesize({ text: "Finished." }));
    const wav = Buffer.from(result.wavBase64, "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect([...wav.subarray(44)]).toEqual([0x34, 0x12, 0xcc, 0xed]);
  });

  it("rejects malformed PCM before starting Parakeet", async () => {
    let transcribed = false;
    const service = await Effect.runPromise(
      makeLiveService({
        transcribe: async () => {
          transcribed = true;
          return "unused";
        },
        synthesize: async () => ({ sampleRate: 24_000, channels: 1, pcm: Buffer.from([0, 0]) }),
      }),
    );
    const error = await Effect.runPromise(
      service
        .transcribe({
          format: "pcm-s16le",
          audioBase64: "AA==",
          sampleRate: 16_000,
          channels: 1,
        })
        .pipe(Effect.flip),
    );
    expect(error).toMatchObject({
      _tag: "JarvisVoiceInvalidInputError",
    });
    expect(transcribed).toBe(false);
  });

  it("rejects audio longer than fifteen seconds at its declared format", async () => {
    let transcribed = false;
    const service = await Effect.runPromise(
      makeLiveService({
        transcribe: async () => {
          transcribed = true;
          return "unused";
        },
        synthesize: async () => ({ sampleRate: 24_000, channels: 1, pcm: Buffer.from([0, 0]) }),
      }),
    );
    const error = await Effect.runPromise(
      service
        .transcribe({
          format: "pcm-s16le",
          audioBase64: Buffer.alloc(480_002).toString("base64"),
          sampleRate: 16_000,
          channels: 1,
        })
        .pipe(Effect.flip),
    );
    expect(error).toMatchObject({ _tag: "JarvisVoiceInvalidInputError" });
    expect(transcribed).toBe(false);
  });

  it("writes canonical WAV header lengths", () => {
    const wav = encodePcmS16LeWav({ pcm: new Uint8Array(320), sampleRate: 16_000, channels: 1 });
    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(356);
    expect(view.getUint32(40, true)).toBe(320);
    expect(view.getUint32(28, true)).toBe(32_000);
  });
});
