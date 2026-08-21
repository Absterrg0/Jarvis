// @effect-diagnostics nodeBuiltinImport:off - path joins mirror packaged native resources.
import { assert, describe, it } from "@effect/vitest";
import * as NodePath from "node:path";

import { kokoroResourceError, kokoroVoicePaths } from "./kokoro-worker-client.ts";
import {
  companionSpeechInterruptPolicy,
  createLatestSpeechQueue,
  interleavedAudioToMono,
  nativeAudioPlaybackTimeoutMs,
  parakeetModelPaths,
  parakeetResourceError,
  parakeetSampleRate,
  speakNativeSpeech,
  startParakeetCapture,
  type ParakeetCaptureDependencies,
} from "./native-speech.ts";

function parakeetHarness(options: { readonly blockModel?: boolean } = {}) {
  let onData: ((samples: Float32Array) => void) | undefined;
  let closeCount = 0;
  let decodeCount = 0;
  let decodedSamples: Float32Array = new Float32Array();
  let writtenWave:
    | { readonly path: string; readonly samples: Float32Array; readonly sampleRate: number }
    | undefined;
  let releaseModel: (() => void) | undefined;
  const modelReady = options.blockModel
    ? new Promise<void>((resolve) => {
        releaseModel = resolve;
      })
    : Promise.resolve();

  const microphone: ParakeetCaptureDependencies["microphone"] = {
    getHosts: () => [{ id: "wasapi", name: "WASAPI" }],
    getDevices: () => [],
    getDefaultOutputDevice: () => ({
      name: "speaker",
      hostId: "wasapi",
      deviceId: "speaker",
      isDefaultInput: false,
      isDefaultOutput: true,
    }),
    getDefaultInputDevice: () => ({
      name: "microphone",
      hostId: "wasapi",
      deviceId: "microphone",
      isDefaultInput: true,
      isDefaultOutput: false,
    }),
    getSupportedInputConfigs: () => [],
    getSupportedOutputConfigs: () => [],
    getDefaultInputConfig: () => ({
      sampleRate: parakeetSampleRate,
      channels: 1,
      sampleFormat: "f32",
    }),
    getDefaultOutputConfig: () => ({
      sampleRate: 48_000,
      channels: 2,
      sampleFormat: "f32",
    }),
    createStream: (deviceId, isInput, _config, callback) => {
      assert.isTrue(isInput);
      onData = callback;
      return { deviceId, streamId: "capture" };
    },
    writeToStream: () => undefined,
    pauseStream: () => undefined,
    resumeStream: () => undefined,
    closeStream: () => {
      closeCount += 1;
    },
  };

  const dependencies: ParakeetCaptureDependencies = {
    microphone,
    runtime: {
      OfflineRecognizer: {
        createAsync: async () => {
          await modelReady;
          return {
            createStream: () => ({
              acceptWaveform: ({ samples }) => {
                decodedSamples = samples;
              },
            }),
            decodeAsync: async () => {
              decodeCount += 1;
              return { text: "Review ripple" };
            },
          };
        },
      },
      LinearResampler: class {
        resample(samples: Float32Array) {
          return samples;
        }
        flush() {
          return new Float32Array();
        }
      },
      writeWave: (path, input) => {
        writtenWave = { path, ...input };
      },
    },
  };

  return {
    dependencies,
    emit: (samples: Float32Array) => onData?.(samples),
    closeCount: () => closeCount,
    decodeCount: () => decodeCount,
    decodedSamples: () => decodedSamples,
    writtenWave: () => writtenWave,
    releaseModel: () => releaseModel?.(),
  };
}

describe("Parakeet capture", () => {
  it("downmixes interleaved microphone channels before 16 kHz recognition", () => {
    assert.deepEqual(
      interleavedAudioToMono(Float32Array.from([1, -1, 0.5, 0.25]), 2),
      Float32Array.from([0, 0.375]),
    );
  });

  it("keeps the 110M INT8 model resident and decodes the full utterance only on release", async () => {
    const test = parakeetHarness({ blockModel: true });
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    let metrics:
      | {
          readonly engineId: "parakeet-tdt-ctc-110m-int8";
          readonly readyLatencyMs?: number;
          readonly firstTranscriptLatencyMs?: number;
          readonly finalLatencyMs: number;
          readonly cpuTimeMs: number;
          readonly peakRssBytes: number;
          readonly resourceBytes: number;
        }
      | undefined;
    const capture = startParakeetCapture({
      paths: parakeetModelPaths("C:/Jarvis/parakeet"),
      dependencies: test.dependencies,
      platform: "win32",
      onReady: () => markReady?.(),
      onMetrics: (value) => {
        metrics = value;
      },
      transformTranscript: (text) => text.replace("ripple", "Rivvl project"),
    });

    await ready;
    test.emit(Float32Array.from([0.1, -0.1, 0.2]));
    assert.equal(
      test.decodeCount(),
      0,
      "capture starts before the resident model finishes warming",
    );
    capture.release();
    assert.equal(test.decodeCount(), 0, "push-to-talk release is the segment boundary");
    test.releaseModel();

    assert.equal(await capture.result, "Review Rivvl project");
    assert.equal(test.decodeCount(), 1);
    assert.deepEqual(test.decodedSamples(), Float32Array.from([0.1, -0.1, 0.2]));
    assert.equal(test.closeCount(), 1);
    assert.isAtLeast(metrics?.readyLatencyMs ?? -1, 0);
    assert.isAtLeast(metrics?.firstTranscriptLatencyMs ?? -1, 0);
    assert.isAtLeast(metrics?.finalLatencyMs ?? -1, 0);
    assert.equal(metrics?.engineId, "parakeet-tdt-ctc-110m-int8");
    assert.isAtLeast(metrics?.cpuTimeMs ?? -1, 0);
    assert.isAbove(metrics?.peakRssBytes ?? 0, 0);
  });

  it("records the exact 16 kHz utterance only when development capture is enabled", async () => {
    const test = parakeetHarness();
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const capture = startParakeetCapture({
      paths: parakeetModelPaths("C:/Jarvis/parakeet"),
      dependencies: test.dependencies,
      platform: "win32",
      recordingDirectory: "C:/Jarvis/captures/42",
      onReady: () => markReady?.(),
    });
    await ready;
    test.emit(Float32Array.from([0.25]));
    capture.release();
    await capture.result;

    assert.deepEqual(test.writtenWave(), {
      path: NodePath.join("C:/Jarvis/captures/42", "capture.wav"),
      samples: Float32Array.from([0.25]),
      sampleRate: parakeetSampleRate,
    });
  });

  it("normalizes every complete utterance to 16 kHz", () => {
    assert.equal(parakeetSampleRate, 16_000);
  });

  it("reports a missing bundled model precisely", () => {
    const error = parakeetResourceError(parakeetModelPaths("/definitely/missing/parakeet"));
    assert.include(error?.message ?? "", "Parakeet encoder");
  });
});

describe("Kokoro voice runtime", () => {
  it("allows ordinary spoken reports to finish instead of killing playback after five seconds", () => {
    assert.isAtLeast(nativeAudioPlaybackTimeoutMs, 120_000);
  });

  it("uses the quantized Kokoro voice bundle", () => {
    const root = NodePath.join("jarvis", "kokoro");
    assert.deepEqual(kokoroVoicePaths(root), {
      resourceRoot: root,
      modelPath: NodePath.join(root, "model.int8.onnx"),
      voicesPath: NodePath.join(root, "voices.bin"),
      tokensPath: NodePath.join(root, "tokens.txt"),
      dataDir: NodePath.join(root, "espeak-ng-data"),
      lexiconPath: NodePath.join(root, "lexicon-us-en.txt"),
    });
  });

  it("reports missing bundled voice resources precisely", () => {
    const error = kokoroResourceError(kokoroVoicePaths("/definitely/missing/kokoro"));
    assert.include(error?.message ?? "", "Kokoro model");
  });

  it("keeps native Kokoro synthesis Windows-only", async () => {
    await speakNativeSpeech("This must not warm Kokoro on this platform.", "linux");
  });

  it("keeps only the latest pending report while a sentence is speaking", async () => {
    const spoken: Array<string> = [];
    const complete: Array<() => void> = [];
    const queue = createLatestSpeechQueue(
      (text) =>
        new Promise<void>((resolve) => {
          spoken.push(text);
          complete.push(resolve);
        }),
    );

    const first = queue.enqueue("First report");
    const stale = queue.enqueue("Stale report");
    const latest = queue.enqueue("Latest report");

    assert.deepEqual(spoken, ["First report"]);
    complete.shift()?.();
    await first;
    await stale;
    assert.deepEqual(spoken, ["First report", "Latest report"]);

    complete.shift()?.();
    await latest;
  });

  it("interrupts current playback, drops the queued report, and can speak again", async () => {
    const spoken: Array<string> = [];
    const aborted: Array<string> = [];
    const resume: Array<() => void> = [];
    const queue = createLatestSpeechQueue(
      (text, signal) =>
        new Promise<void>((resolve) => {
          spoken.push(text);
          const settle = () => resolve();
          const onAbort = () => {
            aborted.push(text);
            settle();
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          resume.push(() => {
            signal.removeEventListener("abort", onAbort);
            settle();
          });
        }),
    );

    const first = queue.enqueue("First report");
    const stale = queue.enqueue("Stale queued report");
    assert.deepEqual(spoken, ["First report"]);
    assert.isTrue(queue.isActive());

    queue.interrupt();
    await first;
    await stale;
    assert.deepEqual(aborted, ["First report"]);
    assert.deepEqual(spoken, ["First report"]);
    assert.isFalse(queue.isActive());

    const next = queue.enqueue("Fresh report");
    assert.deepEqual(spoken, ["First report", "Fresh report"]);
    resume.at(-1)?.();
    await next;
    assert.isFalse(queue.isActive());
  });

  it("treats interruption as a completed speak so Host acknowledgement can proceed", () => {
    const overlay = companionSpeechInterruptPolicy("overlay");
    const tray = companionSpeechInterruptPolicy("tray");
    const capture = companionSpeechInterruptPolicy("capture");
    const relay = companionSpeechInterruptPolicy("relay");

    assert.isTrue(overlay.accepted);
    assert.isTrue(overlay.presentInterrupted);
    assert.isTrue(overlay.completeSpeak);
    assert.isTrue(tray.accepted);
    assert.isTrue(tray.completeSpeak);
    assert.isTrue(capture.accepted);
    assert.isFalse(capture.presentInterrupted);
    assert.isTrue(capture.completeSpeak);
    assert.isFalse(relay.accepted);
    assert.isTrue(relay.completeSpeak);
  });

  it("still fails a genuine playback error", async () => {
    const queue = createLatestSpeechQueue(async () => {
      throw new Error("playback failed");
    });
    const failure = await queue.enqueue("Broken report").catch((cause: unknown) => cause);
    assert.instanceOf(failure, Error);
    assert.equal((failure as Error).message, "playback failed");
  });
});
