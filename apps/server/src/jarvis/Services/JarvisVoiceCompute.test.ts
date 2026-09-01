import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";

import { encodePcmS16LeWav, makeLiveService } from "./JarvisVoiceCompute.ts";

describe("Jarvis voice compute", () => {
  it.effect("sends whole signed-PCM utterances to the resident runtime", () =>
    Effect.gen(function* () {
      const calls: Array<{ audio: Uint8Array; sampleRate: number; channels: number }> = [];
      const service = yield* makeLiveService({
        transcribe: async (input) => {
          calls.push(input);
          return "  start the tests  ";
        },
        synthesize: async () => ({ sampleRate: 24_000, channels: 1, pcm: Buffer.from([0, 0]) }),
      });

      const result = yield* service.transcribe({
        format: "pcm-s16le",
        audioBase64: "AAABAA==",
        sampleRate: 16_000,
        channels: 1,
      });
      expect(result).toEqual({ text: "start the tests" });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call).toBeDefined();
      if (call === undefined) return;
      expect([...call.audio]).toEqual([0, 0, 1, 0]);
      expect(call).toMatchObject({ sampleRate: 16_000, channels: 1 });
    }),
  );

  it.effect("returns Kokoro PCM as a playable mono WAV", () =>
    Effect.gen(function* () {
      const service = yield* makeLiveService({
        transcribe: async () => "unused",
        synthesize: async () => ({
          sampleRate: 24_000,
          channels: 1,
          pcm: Buffer.from([0x34, 0x12, 0xcc, 0xed]),
        }),
      });

      const result = yield* service.synthesize({ text: "Finished." });
      const wav = Buffer.from(result.wavBase64, "base64");
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
      expect(wav.readUInt32LE(24)).toBe(24_000);
      expect([...wav.subarray(44)]).toEqual([0x34, 0x12, 0xcc, 0xed]);
    }),
  );

  it.effect("lets the desktop voice owner reject concurrent work instead of queueing it", () =>
    Effect.gen(function* () {
      let releaseTranscription: (() => void) | undefined;
      let transcriptionActive = false;
      let synthesisCalls = 0;
      const transcriptionReleased = new Promise<void>((resolve) => {
        releaseTranscription = () => {
          transcriptionActive = false;
          resolve();
        };
      });
      let reportTranscriptionStarted: (() => void) | undefined;
      const transcriptionStarted = new Promise<void>((resolve) => {
        reportTranscriptionStarted = resolve;
      });
      const service = yield* makeLiveService({
        transcribe: async () => {
          transcriptionActive = true;
          reportTranscriptionStarted?.();
          await transcriptionReleased;
          return "first";
        },
        synthesize: async () => {
          synthesisCalls += 1;
          if (transcriptionActive) throw new Error("Desktop voice is busy.");
          return { sampleRate: 24_000, channels: 1, pcm: Buffer.from([0, 0]) };
        },
      });

      const first = yield* Effect.forkChild(
        service.transcribe({
          format: "pcm-s16le",
          audioBase64: "AAABAA==",
          sampleRate: 16_000,
          channels: 1,
        }),
      );
      yield* Effect.promise(() => transcriptionStarted);
      const second = yield* Effect.forkChild(
        service.synthesize({ text: "second" }).pipe(Effect.result),
      );
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

      expect(synthesisCalls).toBe(1);
      releaseTranscription?.();
      expect(yield* Fiber.join(first)).toEqual({ text: "first" });
      const secondResult = yield* Fiber.join(second);
      expect(Result.isFailure(secondResult)).toBe(true);
      if (Result.isFailure(secondResult)) {
        expect(secondResult.failure).toMatchObject({
          _tag: "JarvisVoiceRuntimeError",
          message: "Desktop voice is busy.",
        });
      }
    }),
  );

  it.effect("rejects malformed PCM before starting Parakeet", () =>
    Effect.gen(function* () {
      let transcribed = false;
      const service = yield* makeLiveService({
        transcribe: async () => {
          transcribed = true;
          return "unused";
        },
        synthesize: async () => ({ sampleRate: 24_000, channels: 1, pcm: Buffer.from([0, 0]) }),
      });
      const error = yield* service
        .transcribe({
          format: "pcm-s16le",
          audioBase64: "AA==",
          sampleRate: 16_000,
          channels: 1,
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "JarvisVoiceInvalidInputError" });
      expect(transcribed).toBe(false);
    }),
  );

  it.effect("rejects audio longer than fifteen seconds at its declared format", () =>
    Effect.gen(function* () {
      let transcribed = false;
      const service = yield* makeLiveService({
        transcribe: async () => {
          transcribed = true;
          return "unused";
        },
        synthesize: async () => ({ sampleRate: 24_000, channels: 1, pcm: Buffer.from([0, 0]) }),
      });
      const error = yield* service
        .transcribe({
          format: "pcm-s16le",
          audioBase64: Buffer.alloc(480_002).toString("base64"),
          sampleRate: 16_000,
          channels: 1,
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "JarvisVoiceInvalidInputError" });
      expect(transcribed).toBe(false);
    }),
  );

  it("writes canonical WAV header lengths", () => {
    const wav = encodePcmS16LeWav({ pcm: new Uint8Array(320), sampleRate: 16_000, channels: 1 });
    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(356);
    expect(view.getUint32(40, true)).toBe(320);
    expect(view.getUint32(28, true)).toBe(32_000);
  });
});
