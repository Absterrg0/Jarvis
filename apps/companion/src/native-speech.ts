// oxlint-disable t3code/no-global-process-runtime -- this file is the Companion native boundary.
// @effect-diagnostics nodeBuiltinImport:off globalProcess:off - this is a narrow native boundary for the
// companion. It owns local speech runtimes and keeps native process details out of the UI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { createKokoroLifecycle } from "./kokoro-lifecycle.ts";
import { startKokoroWorker } from "./kokoro-worker-client.ts";

type SpeechJob = {
  readonly text: string;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
};

export type CompanionSpeechInterruptSource = "tray" | "overlay" | "capture" | "relay";

/**
 * User-facing stop commands cancel playback locally. The speak promise still
 * completes so Host report acknowledgement is independent of whether the user
 * heard the whole sentence.
 */
export function companionSpeechInterruptPolicy(source: CompanionSpeechInterruptSource): {
  readonly accepted: boolean;
  readonly presentInterrupted: boolean;
  readonly completeSpeak: boolean;
} {
  if (source === "relay") {
    return { accepted: false, presentInterrupted: false, completeSpeak: true };
  }
  return {
    accepted: true,
    presentInterrupted: source !== "capture",
    completeSpeak: true,
  };
}

export type LatestSpeechQueue = {
  readonly enqueue: (text: string) => Promise<void>;
  readonly interrupt: () => void;
  readonly isActive: () => boolean;
};

/**
 * Keeps spoken reports useful when several arrive together: the sentence in
 * progress can be interrupted, stale queued sentences are discarded, and only
 * the latest state remains. A completion report should not be read minutes late.
 */
export function createLatestSpeechQueue(
  speak: (text: string, signal: AbortSignal) => Promise<void>,
): LatestSpeechQueue {
  let active = false;
  let generation = 0;
  let latest: SpeechJob | undefined;
  let currentAbort: AbortController | undefined;

  const run = async (job: SpeechJob, runGeneration: number): Promise<void> => {
    const abort = new AbortController();
    currentAbort = abort;
    try {
      await speak(job.text, abort.signal);
      job.resolve();
    } catch (cause) {
      if (abort.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) {
        job.resolve();
      } else {
        job.reject(cause);
      }
    } finally {
      if (currentAbort === abort) currentAbort = undefined;
      if (generation === runGeneration) {
        const next = latest;
        latest = undefined;
        if (next === undefined) active = false;
        else void run(next, runGeneration);
      }
    }
  };

  return {
    enqueue(text) {
      return new Promise<void>((resolveSpeech, rejectSpeech) => {
        const job: SpeechJob = { text, resolve: resolveSpeech, reject: rejectSpeech };
        if (!active) {
          active = true;
          void run(job, generation);
          return;
        }
        // A replaced report was intentionally skipped, rather than failed.
        latest?.resolve();
        latest = job;
      });
    },
    interrupt() {
      latest?.resolve();
      latest = undefined;
      generation += 1;
      active = false;
      currentAbort?.abort();
      currentAbort = undefined;
    },
    isActive() {
      return active;
    },
  };
}

export const kokoroIdleOffloadMs = 30_000;

const kokoroLifecycle = createKokoroLifecycle({
  startWorker: () => startKokoroWorker(),
  schedule: (delayMs, task) => {
    const controller = new AbortController();
    void NodeTimersPromises.setTimeout(delayMs, undefined, { signal: controller.signal })
      .then(task)
      .catch(() => undefined);
    return () => controller.abort();
  },
  idleMs: kokoroIdleOffloadMs,
});

async function synthesizeAndPlayKokoro(text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const outputPath = await kokoroLifecycle.synthesize(text, signal);
  try {
    if (signal.aborted) return;
    await playNativeCue(outputPath, process.platform, signal);
  } finally {
    await NodeFSP.rm(outputPath, { force: true });
  }
}

const kokoroSpeechQueue = createLatestSpeechQueue(synthesizeAndPlayKokoro);

export type ParakeetModelPaths = {
  readonly encoderPath: string;
  readonly decoderPath: string;
  readonly joinerPath: string;
  readonly tokensPath: string;
};

export function parakeetModelPaths(resourceRoot: string): ParakeetModelPaths {
  return {
    encoderPath: NodePath.join(resourceRoot, "encoder.int8.onnx"),
    decoderPath: NodePath.join(resourceRoot, "decoder.int8.onnx"),
    joinerPath: NodePath.join(resourceRoot, "joiner.int8.onnx"),
    tokensPath: NodePath.join(resourceRoot, "tokens.txt"),
  };
}

export function parakeetResourceError(paths: ParakeetModelPaths): Error | undefined {
  const resources: ReadonlyArray<readonly [string, string]> = [
    [paths.encoderPath, "Parakeet encoder"],
    [paths.decoderPath, "Parakeet decoder"],
    [paths.joinerPath, "Parakeet joiner"],
    [paths.tokensPath, "Parakeet tokens"],
  ];
  const missing = resources.find(([path]) => !NodeFS.existsSync(path));
  return missing === undefined
    ? undefined
    : new Error(
        `Speech recognition is unavailable because the bundled ${missing[1]} is missing. Reinstall Jarvis Companion.`,
      );
}

export type ParakeetCapture = {
  readonly result: Promise<string>;
  release(): void;
  cancel(): void;
};

type ParakeetRecognizer = {
  readonly createStream: () => {
    readonly acceptWaveform: (input: {
      readonly samples: Float32Array;
      readonly sampleRate: number;
    }) => void;
  };
  readonly decodeAsync: (stream: unknown) => Promise<{ readonly text?: string }>;
};

type ParakeetResampler = {
  readonly resample: (samples: Float32Array) => Float32Array;
  readonly flush: (samples: Float32Array) => Float32Array;
};

type ParakeetRuntime = {
  readonly OfflineRecognizer: {
    readonly createAsync: (config: unknown) => Promise<ParakeetRecognizer>;
  };
  readonly LinearResampler: new (inputRate: number, outputRate: number) => ParakeetResampler;
  readonly writeWave: (
    path: string,
    input: { readonly samples: Float32Array; readonly sampleRate: number },
  ) => void;
};

/**
 * Runtime contract for node-cpal 0.1.1.
 *
 * The package's declaration file still advertises createInputStream and
 * createOutputStream, but the native module actually exports one createStream
 * function with an isInput flag. Keep that mismatch at this boundary instead
 * of allowing the stale declaration to shape capture code.
 */
export type NativeMicrophoneStreamConfig = {
  readonly minSampleRate?: number;
  readonly maxSampleRate?: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly sampleFormat: "i16" | "u16" | "f32";
};

export type NativeMicrophoneDevice = {
  readonly name: string;
  readonly hostId: string;
  readonly deviceId: string;
  readonly isDefaultInput: boolean;
  readonly isDefaultOutput: boolean;
};

export type NativeMicrophoneHost = {
  readonly id: string;
  readonly name: string;
};

export type NativeMicrophoneStream = {
  readonly deviceId: string;
  readonly streamId: string;
};

export type NativeMicrophone = {
  readonly getHosts: () => ReadonlyArray<NativeMicrophoneHost>;
  readonly getDevices: (hostId?: string) => ReadonlyArray<NativeMicrophoneDevice>;
  readonly getDefaultOutputDevice: () => NativeMicrophoneDevice;
  readonly getDefaultInputDevice: () => NativeMicrophoneDevice;
  readonly getSupportedInputConfigs: (
    deviceId: string,
  ) => ReadonlyArray<NativeMicrophoneStreamConfig>;
  readonly getSupportedOutputConfigs: (
    deviceId: string,
  ) => ReadonlyArray<NativeMicrophoneStreamConfig>;
  readonly getDefaultInputConfig: (deviceId: string) => NativeMicrophoneStreamConfig;
  readonly getDefaultOutputConfig: (deviceId: string) => NativeMicrophoneStreamConfig;
  readonly createStream: (
    deviceId: string,
    isInput: boolean,
    config: NativeMicrophoneStreamConfig,
    onData?: (data: Float32Array) => void,
  ) => NativeMicrophoneStream;
  readonly writeToStream: (stream: NativeMicrophoneStream, data: Float32Array) => void;
  readonly pauseStream: (stream: NativeMicrophoneStream) => void;
  readonly resumeStream: (stream: NativeMicrophoneStream) => void;
  readonly closeStream: (stream: NativeMicrophoneStream) => void;
};

function createNativeInputStream(
  microphone: NativeMicrophone,
  deviceId: string,
  config: NativeMicrophoneStreamConfig,
  onData: (data: Float32Array) => void,
): NativeMicrophoneStream {
  return microphone.createStream(deviceId, true, config, onData);
}

export type ParakeetCaptureDependencies = {
  readonly microphone: NativeMicrophone;
  readonly runtime: ParakeetRuntime;
};

export type ParakeetCaptureInput = {
  readonly paths: ParakeetModelPaths;
  /** Fires after the model and microphone are both ready. */
  readonly onReady?: () => void;
  readonly onTranscript?: (transcript: string) => void;
  readonly onMetrics?: (metrics: {
    readonly engineId: "parakeet-tdt-ctc-110m-int8";
    readonly readyLatencyMs?: number;
    readonly firstTranscriptLatencyMs?: number;
    readonly finalLatencyMs: number;
    readonly cpuTimeMs: number;
    readonly peakRssBytes: number;
    readonly resourceBytes: number;
  }) => void;
  /** Applies live Host vocabulary after Parakeet returns grounded text. */
  readonly transformTranscript?: (transcript: string) => string;
  /** Development-only directory where the exact 16 kHz input is retained. */
  readonly recordingDirectory?: string;
  readonly dependencies?: ParakeetCaptureDependencies;
  readonly platform?: string;
};

const require = NodeModule.createRequire(import.meta.url);
let cachedParakeet:
  | { readonly key: string; readonly recognizer: Promise<ParakeetRecognizer> }
  | undefined;

const nativeMicrophoneContract = [
  "getDefaultInputDevice",
  "getDefaultInputConfig",
  "createStream",
  "closeStream",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Validates node-cpal's runtime API before it crosses the native boundary. */
export function validateNativeMicrophone(value: unknown): NativeMicrophone {
  if (!isRecord(value)) {
    throw new Error("Packaged node-cpal did not load an object.");
  }
  const missing = nativeMicrophoneContract.find((name) => typeof value[name] !== "function");
  if (missing !== undefined) {
    throw new Error(`Packaged node-cpal is missing required function ${missing}.`);
  }
  return value as unknown as NativeMicrophone;
}

function loadNativeMicrophone(): NativeMicrophone {
  return validateNativeMicrophone(require("node-cpal"));
}

/** Loads and validates node-cpal without enumerating or opening a physical device. */
export function prepareNativeMicrophone(platform = process.platform): void {
  if (platform !== "win32") return;
  loadNativeMicrophone();
}

function nativeParakeetDependencies(): ParakeetCaptureDependencies {
  return {
    microphone: loadNativeMicrophone(),
    runtime: require("sherpa-onnx-node") as ParakeetRuntime,
  };
}

function recognizerKey(paths: ParakeetModelPaths) {
  return [paths.encoderPath, paths.decoderPath, paths.joinerPath, paths.tokensPath].join("\n");
}

async function parakeetRecognizer(
  input: ParakeetCaptureInput,
  dependencies: ParakeetCaptureDependencies,
): Promise<ParakeetRecognizer> {
  const key = recognizerKey(input.paths);
  if (input.dependencies === undefined && cachedParakeet?.key === key) {
    return await cachedParakeet.recognizer;
  }
  const resourceError = parakeetResourceError(input.paths);
  if (resourceError !== undefined && input.dependencies === undefined) throw resourceError;
  const recognizer = dependencies.runtime.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: input.paths.encoderPath,
        decoder: input.paths.decoderPath,
        joiner: input.paths.joinerPath,
      },
      tokens: input.paths.tokensPath,
      numThreads: 4,
      provider: "cpu",
      debug: false,
    },
  });
  if (input.dependencies === undefined) cachedParakeet = { key, recognizer };
  try {
    return await recognizer;
  } catch (cause) {
    if (cachedParakeet?.recognizer === recognizer) cachedParakeet = undefined;
    throw cause;
  }
}

export async function prepareParakeetRecognition(
  paths: ParakeetModelPaths,
  platform = process.platform,
): Promise<void> {
  if (platform !== "win32") return;
  const dependencies = nativeParakeetDependencies();
  await parakeetRecognizer({ paths, platform }, dependencies);
}

function concatenateSamples(chunks: ReadonlyArray<Float32Array>, length: number): Float32Array {
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function interleavedAudioToMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples;
  const frameCount = Math.floor(samples.length / channels);
  const mono = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let total = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      total += samples[frame * channels + channel] ?? 0;
    }
    mono[frame] = total / channels;
  }
  return mono;
}

export const parakeetSampleRate = 16_000;
function startParakeetCaptureInternal(input: ParakeetCaptureInput): ParakeetCapture {
  if ((input.platform ?? process.platform) !== "win32") {
    throw new Error("Local Parakeet recognition is available on Windows only.");
  }
  let settled = false;
  let released = false;
  let finalizing = false;
  let microphone: NativeMicrophone | undefined;
  let stream: NativeMicrophoneStream | undefined;
  let resampler: ParakeetResampler | undefined;
  let dependencies: ParakeetCaptureDependencies | undefined;
  let recognizerPromise: Promise<ParakeetRecognizer> | undefined;
  const chunks: Array<Float32Array> = [];
  let sampleCount = 0;
  const startedAt = performance.now();
  const startedCpu = process.cpuUsage();
  let peakRssBytes = process.memoryUsage().rss;
  let readyAt: number | undefined;
  let firstTranscriptAt: number | undefined;
  const lifetimeAbort = new AbortController();
  let resolveResult: (transcript: string) => void;
  let rejectResult: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const closeMicrophone = () => {
    if (stream === undefined || microphone === undefined) return;
    microphone.closeStream(stream);
    stream = undefined;
  };
  const observeRss = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  const finish = (value: string | Error) => {
    if (settled) return;
    settled = true;
    lifetimeAbort.abort();
    closeMicrophone();
    observeRss();
    const cpu = process.cpuUsage(startedCpu);
    const resourceBytes = [
      input.paths.encoderPath,
      input.paths.decoderPath,
      input.paths.joinerPath,
      input.paths.tokensPath,
    ].reduce((total, path) => {
      try {
        return total + NodeFS.statSync(path).size;
      } catch {
        return total;
      }
    }, 0);
    try {
      input.onMetrics?.({
        engineId: "parakeet-tdt-ctc-110m-int8",
        ...(readyAt === undefined ? {} : { readyLatencyMs: readyAt - startedAt }),
        ...(firstTranscriptAt === undefined
          ? {}
          : { firstTranscriptLatencyMs: firstTranscriptAt - startedAt }),
        finalLatencyMs: performance.now() - startedAt,
        cpuTimeMs: (cpu.user + cpu.system) / 1_000,
        peakRssBytes,
        resourceBytes,
      });
    } catch {
      // Development metrics are observational and cannot change capture completion.
    }
    if (value instanceof Error) rejectResult(value);
    else resolveResult(value);
  };

  const finalize = async () => {
    if (settled || finalizing || stream === undefined || resampler === undefined) return;
    finalizing = true;
    closeMicrophone();
    const tail = resampler.flush(new Float32Array());
    if (tail.length > 0) {
      chunks.push(tail);
      sampleCount += tail.length;
    }
    const samples = concatenateSamples(chunks, sampleCount);
    try {
      const activeDependencies = dependencies ?? input.dependencies ?? nativeParakeetDependencies();
      if (input.recordingDirectory !== undefined) {
        activeDependencies.runtime.writeWave(
          NodePath.join(input.recordingDirectory, "capture.wav"),
          {
            samples,
            sampleRate: parakeetSampleRate,
          },
        );
      }
      if (samples.length === 0) {
        finish(new Error("I didn't hear a complete instruction. Try again."));
        return;
      }
      const recognizer = await (recognizerPromise ?? parakeetRecognizer(input, activeDependencies));
      const recognitionStream = recognizer.createStream();
      recognitionStream.acceptWaveform({ samples, sampleRate: parakeetSampleRate });
      const decoded = await recognizer.decodeAsync(recognitionStream);
      const rawTranscript = decoded.text?.replace(/\s+/gu, " ").trim() ?? "";
      if (rawTranscript.length === 0) {
        finish(new Error("I didn't hear a complete instruction. Try again."));
        return;
      }
      firstTranscriptAt = performance.now();
      let transcript = rawTranscript;
      try {
        transcript = input.transformTranscript?.(rawTranscript) ?? rawTranscript;
      } catch {
        // Vocabulary repair is advisory; never discard valid Parakeet output.
      }
      try {
        input.onTranscript?.(transcript);
      } catch {
        // Rendering the final transcript cannot invalidate recognition.
      }
      finish(transcript);
    } catch (cause) {
      finish(cause instanceof Error ? cause : new Error("Local Parakeet recognition failed."));
    }
  };

  const release = () => {
    if (settled || released) return;
    released = true;
    void finalize();
  };

  void (async () => {
    try {
      dependencies = input.dependencies ?? nativeParakeetDependencies();
      recognizerPromise = parakeetRecognizer(input, dependencies);
      void recognizerPromise.catch((cause: unknown) => {
        finish(cause instanceof Error ? cause : new Error("Local Parakeet could not start."));
      });
      if (settled) return;
      if (released) {
        finish(new Error("Voice capture stopped before the microphone was ready."));
        return;
      }
      microphone = dependencies.microphone;
      const device = microphone.getDefaultInputDevice();
      const deviceConfig = microphone.getDefaultInputConfig(device.deviceId);
      resampler = new dependencies.runtime.LinearResampler(
        deviceConfig.sampleRate,
        parakeetSampleRate,
      );
      stream = createNativeInputStream(
        microphone,
        device.deviceId,
        {
          sampleRate: deviceConfig.sampleRate,
          channels: deviceConfig.channels,
          sampleFormat: deviceConfig.sampleFormat,
        },
        (data) => {
          if (settled || released || resampler === undefined) return;
          const samples = resampler.resample(interleavedAudioToMono(data, deviceConfig.channels));
          if (samples.length === 0) return;
          chunks.push(samples.slice());
          sampleCount += samples.length;
        },
      );
      readyAt = performance.now();
      observeRss();
      try {
        input.onReady?.();
      } catch {
        // A presentation callback cannot stop the microphone.
      }
    } catch (cause) {
      finish(cause instanceof Error ? cause : new Error("Local Parakeet could not start."));
    }
  })();

  return {
    result,
    release,
    cancel: () => finish(new Error("Voice capture cancelled.")),
  };
}

/** Captures one explicit push-to-talk utterance and decodes it with Parakeet on release. */
export function startParakeetCapture(input: ParakeetCaptureInput): ParakeetCapture {
  return startParakeetCaptureInternal(input);
}

export function speakNativeSpeech(text: string, platform = process.platform): Promise<void> {
  if (platform !== "win32" || text.trim().length === 0) return Promise.resolve();
  return kokoroSpeechQueue.enqueue(text);
}

/** Warms Kokoro only after this device has won the Host speaker claim. */
export async function prepareNativeSpeech(platform = process.platform): Promise<void> {
  if (platform !== "win32") return;
  await kokoroLifecycle.prewarm();
}

/** Stops current Kokoro playback, discards queued speech, and releases model memory. */
export function interruptNativeSpeech(): void {
  kokoroSpeechQueue.interrupt();
  kokoroLifecycle.interrupt();
}

export function isNativeSpeechActive(): boolean {
  return kokoroSpeechQueue.isActive();
}

export async function disposeNativeSpeech(): Promise<void> {
  kokoroSpeechQueue.interrupt();
  await kokoroLifecycle.dispose();
}

export async function playNativeCue(
  path: string,
  platform = process.platform,
  signal?: AbortSignal,
): Promise<void> {
  if (platform !== "win32") return;
  if (signal?.aborted) return;
  const escapedPath = path.replaceAll("'", "''");
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$cue = New-Object System.Media.SoundPlayer '${escapedPath}'; $cue.PlaySync()`,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let settled = false;
    const timeoutAbort = new AbortController();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      timeoutAbort.abort();
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        if (!child.killed) child.kill();
        reject(error);
        return;
      }
      resolve();
    };
    const onAbort = () => {
      if (!child.killed) child.kill();
      finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void NodeTimersPromises.setTimeout(nativeAudioPlaybackTimeoutMs, undefined, {
      signal: timeoutAbort.signal,
    })
      .then(() => finish(new Error("Jarvis voice playback took too long.")))
      .catch(() => undefined);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, exitSignal) => {
      if (signal?.aborted) {
        finish();
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          exitSignal === null
            ? `Jarvis voice playback stopped (exit ${code ?? "unknown"}).`
            : `Jarvis voice playback stopped (${exitSignal}).`,
        ),
      );
    });
  });
}

export const nativeAudioPlaybackTimeoutMs = 120_000;
