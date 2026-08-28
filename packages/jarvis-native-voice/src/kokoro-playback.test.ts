// @effect-diagnostics nodeBuiltinImport:off - native playback is replaced by a deterministic audio-device fake.
import * as NodeTimersPromises from "node:timers/promises";
import { afterEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  createStream: vi.fn(() => "output-stream"),
  writeToStream: vi.fn(),
  closeStream: vi.fn(),
  synthesize: vi.fn(),
}));
vi.mock("node:module", async () => {
  const actual = await vi.importActual<typeof import("node:module")>("node:module");
  const nativeRequire = actual.createRequire(import.meta.url);
  return {
    ...actual,
    createRequire: () =>
      Object.assign(
        (id: string) => {
          if (id === "node-cpal") {
            return {
              getDefaultOutputDevice: () => ({ deviceId: "speaker" }),
              createStream: fixture.createStream,
              writeToStream: fixture.writeToStream,
              closeStream: fixture.closeStream,
            };
          }
          if (id === "sherpa-onnx-node") {
            return {
              readWave: () => ({ samples: Float32Array.from([0.25]), sampleRate: 24_000 }),
            };
          }
          return nativeRequire(id);
        },
        { resolve: nativeRequire.resolve },
      ),
  };
});
vi.mock("./kokoro-worker-client.ts", () => ({
  startKokoroWorker: async () => ({ synthesize: fixture.synthesize, close: async () => {} }),
}));

import {
  disposeNativeSpeech,
  onNativeSpeechTiming,
  speakNativeSpeech,
  type NativeSpeechTiming,
} from "./native-speech.ts";

afterEach(async () => {
  await disposeNativeSpeech();
  vi.clearAllMocks();
});

it("starts the first chunk before the remainder of the response finishes synthesizing", async () => {
  const timings: NativeSpeechTiming[] = [];
  const removeTimingListener = onNativeSpeechTiming((timing) => timings.push(timing));
  const started = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<{
    chunkCount: number;
    totalSamples: number;
    sampleRate: number;
    synthesisDurationMs: number;
    synthesisCpuMs: number;
    peakRssBytes: number;
    firstChunkReadyMs: number;
  }>();
  fixture.synthesize.mockImplementation((_text: string, onChunk: (path: string) => void) => {
    onChunk("first.wav");
    started.resolve();
    return complete.promise;
  });
  const speaking = speakNativeSpeech("First sentence. The rest takes longer.");
  try {
    await started.promise;
    // Flush the playback promise chain, without allowing full synthesis to complete.
    await NodeTimersPromises.setImmediate();
    expect(fixture.createStream).toHaveBeenCalledTimes(1);
    expect(fixture.writeToStream).toHaveBeenCalled();
  } finally {
    complete.resolve({
      chunkCount: 2,
      totalSamples: 48_000,
      sampleRate: 24_000,
      synthesisDurationMs: 2_000,
      synthesisCpuMs: 3_000,
      peakRssBytes: 400_000_000,
      firstChunkReadyMs: 500,
    });
    await speaking;
  }
  expect(timings).toEqual([
    expect.objectContaining({
      start: "cold",
      firstChunkReadyMs: 500,
      synthesisMs: 2_000,
      chunkCount: 2,
    }),
  ]);
  expect(timings[0]?.firstPlaybackStartMs).toBeTypeOf("number");
  expect(timings[0]?.totalMs).toBeTypeOf("number");

  await speakNativeSpeech("A second warm response.");
  const warmTiming = timings.at(-1);
  expect(warmTiming).toEqual(
    expect.objectContaining({ start: "warm", warmupMs: 0, synthesisMs: 2_000 }),
  );
  expect(warmTiming?.firstPlaybackStartMs).toBeTypeOf("number");
  removeTimingListener();
});
