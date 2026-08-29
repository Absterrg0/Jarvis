// oxlint-disable t3code/no-global-process-runtime -- this file is the native voice boundary.
// @effect-diagnostics nodeBuiltinImport:off globalProcess:off globalTimers:off - this is a narrow native boundary for the
// host application. It owns local speech runtimes and keeps native process details out of the UI.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeTimers from "node:timers";
import * as NodeTimersPromises from "node:timers/promises";

import { createKokoroLifecycle } from "./kokoro-lifecycle.ts";
import { startKokoroWorker } from "./kokoro-worker-client.ts";
import { createContinuousSpeechPlayback, type ContinuousSpeechPlayback } from "./speech-audio.ts";
export {
  createNodeCpalSpeechOutput,
  type NodeCpalSpeechOutput,
  type NodeCpalSpeechOutputRuntime,
} from "./desktop-native-voice.ts";
import {
  loadNativeMicrophone,
  isNativeMicrophonePlatform,
  normalizedAudioRms,
} from "./desktop-native-voice.ts";
import type {
  NativeMicrophone,
  NativeMicrophoneDevice,
  NativeMicrophoneStream,
  NativeMicrophoneStreamConfig,
  NativeSpeechProcess,
  NativeSpeechProcessDependencies,
} from "./desktop-native-voice.ts";
import type { NativeSpeechInterruptSource, NativeSpeechTiming } from "./desktop-native-voice.ts";
export {
  isNativeMicrophonePlatform,
  normalizedAudioRms,
  prepareNativeMicrophone,
  startNativePcmCapture,
  validateNativeMicrophone,
} from "./desktop-native-voice.ts";
export type {
  NativeMicrophone,
  NativeMicrophoneDevice,
  NativeMicrophoneHost,
  NativeMicrophoneStream,
  NativeMicrophoneStreamConfig,
  NativePcmCapture,
  NativePcmCaptureInput,
  NativeSpeechInterruptSource,
  NativeSpeechProcess,
  NativeSpeechProcessDependencies,
} from "./desktop-native-voice.ts";
import { classifyVoiceCaptureError, createVoiceCaptureError } from "./voice-capture-error.ts";
import { createSpeechQueue, type SpeechReservation, type SpeechQueue } from "./speech-arbiter.ts";

export {
  classifyVoiceCaptureError,
  createVoiceCaptureError,
  isVoiceCaptureErrorCode,
  voiceCaptureErrorCodes,
} from "./voice-capture-error.ts";
export type { VoiceCaptureError, VoiceCaptureErrorCode } from "./voice-capture-error.ts";

/**
 * User-facing stop commands cancel playback locally. The speak promise still
 * completes so Host report acknowledgement is independent of whether the user
 * heard the whole sentence.
 */
export function nativeSpeechInterruptPolicy(source: NativeSpeechInterruptSource): {
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

export type { SpeechReservation } from "./speech-arbiter.ts";

/**
 * Legacy Kokoro entry point. Desktop's active report path uses the delivery-ID
 * aware queue directly; this wrapper keeps the older text-only call shape.
 */
export type LatestSpeechQueue = Omit<SpeechQueue, "enqueue"> & {
  readonly enqueue: (text: string) => ReturnType<SpeechQueue["enqueue"]>;
};

export const createLatestSpeechQueue = (
  speak: (text: string, signal: AbortSignal) => Promise<void>,
): LatestSpeechQueue => {
  let activeReportId: string | undefined;
  let pendingReportId: string | undefined;
  const queue = createSpeechQueue(async (text, signal, deliveryId) => {
    if (deliveryId !== undefined) activeReportId = deliveryId;
    try {
      await speak(text, signal);
    } finally {
      if (activeReportId === deliveryId) activeReportId = undefined;
    }
  });
  let sequence = 0;
  return {
    ...queue,
    enqueue: (text) => {
      const deliveryId = `legacy-report-${++sequence}`;
      if (pendingReportId !== undefined && pendingReportId !== activeReportId) {
        queue.cancel(pendingReportId);
      }
      pendingReportId = deliveryId;
      const completion = queue.enqueue(text, deliveryId);
      void completion.then(
        () => {
          if (pendingReportId === deliveryId) pendingReportId = undefined;
        },
        () => {
          if (pendingReportId === deliveryId) pendingReportId = undefined;
        },
      );
      return completion;
    },
  };
};

// Keep Kokoro warm across the short bursts that make up one task/report. This
// window also covers normal task execution after capture has finished.
export const kokoroIdleOffloadMs = 5 * 60_000;

export type { NativeSpeechTiming };

const nativeSpeechTimingListeners = new Set<(timing: NativeSpeechTiming) => void>();

export function onNativeSpeechTiming(listener: (timing: NativeSpeechTiming) => void): () => void {
  nativeSpeechTimingListeners.add(listener);
  return () => nativeSpeechTimingListeners.delete(listener);
}

const kokoroLifecycle = createKokoroLifecycle({
  startWorker: (signal) => startKokoroWorker(signal === undefined ? {} : { signal }),
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
  const startedAt = performance.now();
  let firstPlaybackStartMs: number | undefined;
  let playback: ContinuousSpeechPlayback | undefined;
  let playbackSampleRate: number | undefined;
  const abortPlayback = () => playback?.abort();
  signal.addEventListener("abort", abortPlayback, { once: true });
  let metrics: Awaited<ReturnType<typeof kokoroLifecycle.synthesize>>;
  try {
    metrics = await kokoroLifecycle.synthesize(
      text,
      async (outputPath) => {
        if (signal.aborted) return;
        const audio = readKokoroWave(outputPath);
        if (playbackSampleRate !== undefined && playbackSampleRate !== audio.sampleRate) {
          throw new Error("Kokoro changed sample rate during one spoken response.");
        }
        playbackSampleRate = audio.sampleRate;
        playback ??= createNativeSpeechPlayback(audio.sampleRate, signal);
        firstPlaybackStartMs ??= performance.now() - startedAt;
        await playback.write(audio.samples);
      },
      signal,
    );
    await playback?.finish();
  } catch (cause) {
    playback?.abort();
    throw cause;
  } finally {
    signal.removeEventListener("abort", abortPlayback);
  }
  const timing: NativeSpeechTiming = {
    engineId: "kokoro-int8",
    start: metrics.cold ? "cold" : "warm",
    warmupMs: metrics.warmupMs ?? 0,
    ...(firstPlaybackStartMs === undefined ? {} : { firstPlaybackStartMs }),
    ...(metrics.firstChunkReadyMs === undefined
      ? {}
      : { firstChunkReadyMs: metrics.firstChunkReadyMs }),
    synthesisMs: metrics.synthesisDurationMs,
    totalMs: performance.now() - startedAt,
    synthesisCpuMs: metrics.synthesisCpuMs,
    peakRssBytes: metrics.peakRssBytes,
    chunkCount: metrics.chunkCount,
  };
  for (const listener of nativeSpeechTimingListeners) {
    try {
      listener(timing);
    } catch {
      // Diagnostics cannot interrupt speech completion.
    }
  }
}

const kokoroSpeechQueue = createLatestSpeechQueue(synthesizeAndPlayKokoro);

export function setNativeSpeechRetention(retained: boolean): void {
  kokoroLifecycle.setRetention(retained);
}

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
        `Speech recognition is unavailable because the bundled ${missing[1]} is missing. Reinstall Jarvis.`,
      );
}

export type ParakeetCapture = {
  readonly result: Promise<string>;
  release(): void;
  cancel(): void;
};

type ParakeetRecognizer = {
  readonly createStream: (hotwords?: string) => {
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

type NativeAudioOutput = Pick<NativeMicrophone, "createStream" | "closeStream"> & {
  readonly getDefaultOutputDevice: () => NativeMicrophoneDevice;
  readonly writeToStream: (stream: NativeMicrophoneStream, samples: Float32Array) => void;
};

type NativeWaveReader = {
  readonly readWave: (
    path: string,
    enableExternalBuffer: boolean,
  ) => { readonly samples: Float32Array; readonly sampleRate: number };
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
  /** Live names that should win over similar common-word transcripts. */
  readonly contextualPhrases?: ReadonlyArray<string> | (() => ReadonlyArray<string>);
  /** Fires after the model and microphone are both ready. */
  readonly onReady?: () => void;
  /** Fires once when the input stream delivers its first non-empty frame. */
  readonly onFirstAudioFrame?: () => void;
  /** Throttled, normalized RMS level from the incoming PCM boundary. */
  readonly onAudioLevel?: (level: number) => void;
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

/** A Parakeet session fed by PCM owned by a renderer or another caller. */
export type ParakeetPcmCapture = ParakeetCapture & {
  readonly feed: (samples: Float32Array) => void;
};

export type ParakeetPcmCaptureInput = Omit<ParakeetCaptureInput, "dependencies" | "platform"> & {
  readonly sampleRate: number;
  readonly channels: number;
  readonly dependencies?: Pick<ParakeetCaptureDependencies, "runtime">;
  readonly platform?: string;
};

type ParakeetPcmCaptureCoreInput = Omit<ParakeetPcmCaptureInput, "sampleRate" | "channels">;

type ParakeetPcmCaptureSource = {
  readonly sampleRate: number;
  readonly channels: number;
  readonly start: (onData: (data: Float32Array) => void) => void;
  readonly close: () => void;
};

type ParakeetPcmCaptureSetup = {
  readonly source: ParakeetPcmCaptureSource;
  readonly dependencies: Pick<ParakeetCaptureDependencies, "runtime">;
  readonly checkResources: boolean;
};

const require = NodeModule.createRequire(import.meta.url);
let cachedParakeet:
  | { readonly key: string; readonly recognizer: Promise<ParakeetRecognizer> }
  | undefined;

const nativeAudioOutputContract = [
  "getDefaultOutputDevice",
  "createStream",
  "writeToStream",
  "closeStream",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function loadNativeAudioOutput(): NativeAudioOutput {
  const value = require("node-cpal") as unknown;
  if (!isRecord(value)) throw new Error("Packaged node-cpal did not load an object.");
  const missing = nativeAudioOutputContract.find((name) => typeof value[name] !== "function");
  if (missing !== undefined) {
    throw new Error(`Packaged node-cpal is missing required function ${missing}.`);
  }
  return value as unknown as NativeAudioOutput;
}

function readKokoroWave(path: string): {
  readonly samples: Float32Array;
  readonly sampleRate: number;
} {
  const runtime = require("sherpa-onnx-node") as NativeWaveReader;
  const audio = runtime.readWave(path, false);
  return { samples: audio.samples, sampleRate: audio.sampleRate };
}

function createNativeSpeechPlayback(
  sampleRate: number,
  signal: AbortSignal,
): ContinuousSpeechPlayback {
  const output = loadNativeAudioOutput();
  return createContinuousSpeechPlayback({
    sampleRate,
    aborted: () => signal.aborted,
    wait: async (durationMs) => {
      try {
        await NodeTimersPromises.setTimeout(durationMs, undefined, { signal });
      } catch {
        // Abort closes the stream through the speech reservation.
      }
    },
    open: () => {
      const device = output.getDefaultOutputDevice();
      const stream = output.createStream(
        device.deviceId,
        false,
        { sampleRate, channels: 1, sampleFormat: "f32" },
        () => undefined,
      );
      return {
        write: (samples) => output.writeToStream(stream, samples),
        close: () => output.closeStream(stream),
      };
    },
  });
}

export function isNativeSpeechPlatform(platform: string = process.platform): boolean {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

function nativeParakeetRuntime(): ParakeetRuntime {
  return require("sherpa-onnx-node") as ParakeetRuntime;
}

function nativeParakeetDependencies(): ParakeetCaptureDependencies {
  return {
    microphone: loadNativeMicrophone(),
    runtime: nativeParakeetRuntime(),
  };
}

function recognizerKey(paths: ParakeetModelPaths) {
  return [paths.encoderPath, paths.decoderPath, paths.joinerPath, paths.tokensPath].join("\n");
}

const PARAKEET_MAX_CONTEXTUAL_PHRASES = 64;
const PARAKEET_HOTWORD_SCORE = 2;
const parakeetTokensByPath = new Map<
  string,
  { readonly tokens: ReadonlySet<string>; readonly maximumLength: number }
>();

function parakeetTokens(tokensPath: string): {
  readonly tokens: ReadonlySet<string>;
  readonly maximumLength: number;
} {
  const cached = parakeetTokensByPath.get(tokensPath);
  if (cached !== undefined) return cached;
  const values = NodeFS.readFileSync(tokensPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((token) => token.length > 0 && !token.startsWith("<"));
  const loaded = {
    tokens: new Set(values),
    maximumLength: Math.max(0, ...values.map((token) => token.length)),
  };
  parakeetTokensByPath.set(tokensPath, loaded);
  return loaded;
}

function tokenizeParakeetWord(
  word: string,
  vocabulary: ReturnType<typeof parakeetTokens>,
): ReadonlyArray<string> | undefined {
  const variants = [
    word,
    word.toLocaleLowerCase("en-US"),
    `${word.slice(0, 1).toLocaleUpperCase("en-US")}${word.slice(1).toLocaleLowerCase("en-US")}`,
  ];
  for (const variant of new Set(variants)) {
    const target = variant;
    const memo = new Map<number, ReadonlyArray<string> | undefined>();
    const tokenizeFrom = (offset: number): ReadonlyArray<string> | undefined => {
      if (offset === target.length) return [];
      if (memo.has(offset)) return memo.get(offset);
      const maximum = Math.min(vocabulary.maximumLength, target.length - offset);
      for (let length = maximum; length > 0; length -= 1) {
        const candidate = target.slice(offset, offset + length);
        if (!vocabulary.tokens.has(candidate)) continue;
        const remainder = tokenizeFrom(offset + candidate.length);
        if (remainder === undefined) continue;
        const result = [candidate, ...remainder];
        memo.set(offset, result);
        return result;
      }
      memo.set(offset, undefined);
      return undefined;
    };
    const tokens = tokenizeFrom(0);
    // sherpa's per-stream parser treats SentencePiece's leading marker as a
    // standalone token. Feeding a combined token such as `▁Al` is split into
    // `▁` and `Al`, which fails when only `▁Al` exists in tokens.txt.
    if (tokens !== undefined && vocabulary.tokens.has("▁")) return ["▁", ...tokens];
  }
  return undefined;
}

/** Builds sherpa's per-stream token hotwords from bounded live vocabulary. */
export function buildParakeetHotwords(
  phrases: ReadonlyArray<string>,
  tokensPath: string,
): string | undefined {
  if (phrases.length === 0) return undefined;
  const vocabulary = parakeetTokens(tokensPath);
  const encoded = [...new Set(phrases.map((phrase) => phrase.trim()).filter(Boolean))]
    .slice(0, PARAKEET_MAX_CONTEXTUAL_PHRASES)
    .flatMap((phrase) => {
      const words = phrase.match(/[\p{Letter}\p{Number}]+/gu) ?? [];
      if (words.length === 0 || words.length > 8) return [];
      const tokenizedWords = words.map((word) => tokenizeParakeetWord(word, vocabulary));
      if (tokenizedWords.some((tokens) => tokens === undefined)) return [];
      const tokens = tokenizedWords.flatMap((wordTokens) => wordTokens ?? []);
      if (tokens.length === 0) return [];
      return [`${tokens.join(" ")} :${PARAKEET_HOTWORD_SCORE.toFixed(1)}`];
    });
  return encoded.length === 0 ? undefined : encoded.join("/");
}

function resolvedParakeetContextualPhrases(
  contextualPhrases: ParakeetCaptureInput["contextualPhrases"],
): ReadonlyArray<string> {
  try {
    return typeof contextualPhrases === "function"
      ? contextualPhrases()
      : (contextualPhrases ?? []);
  } catch {
    return [];
  }
}

async function parakeetRecognizer(
  input: Pick<ParakeetCaptureInput, "paths">,
  runtime: ParakeetRuntime,
  cache = true,
  checkResources = true,
): Promise<ParakeetRecognizer> {
  const key = recognizerKey(input.paths);
  if (cache && cachedParakeet?.key === key) {
    return await cachedParakeet.recognizer;
  }
  const resourceError = parakeetResourceError(input.paths);
  if (resourceError !== undefined && checkResources) throw resourceError;
  const recognizer = runtime.OfflineRecognizer.createAsync({
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
    decodingMethod: "modified_beam_search",
    maxActivePaths: 4,
  });
  if (cache) cachedParakeet = { key, recognizer };
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
  if (!isNativeSpeechPlatform(platform)) return;
  await parakeetRecognizer({ paths }, nativeParakeetRuntime());
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
const AUDIO_LEVEL_INTERVAL_MS = 90;
function startParakeetPcmCaptureInternal(
  input: ParakeetPcmCaptureCoreInput,
  setupPromise: ParakeetPcmCaptureSetup | Promise<ParakeetPcmCaptureSetup>,
): ParakeetPcmCapture {
  if (!isNativeSpeechPlatform(input.platform ?? process.platform)) {
    throw new Error("Local Parakeet recognition is unavailable on this platform.");
  }
  let settled = false;
  let released = false;
  let finalizing = false;
  let finalizeRequested = false;
  let source: ParakeetPcmCaptureSource | undefined;
  let sourceClosed = false;
  let resampler: ParakeetResampler | undefined;
  let dependencies: Pick<ParakeetCaptureDependencies, "runtime"> | undefined;
  let recognizerPromise: Promise<ParakeetRecognizer> | undefined;
  const chunks: Array<Float32Array> = [];
  let sampleCount = 0;
  const startedAt = performance.now();
  const startedCpu = process.cpuUsage();
  let peakRssBytes = process.memoryUsage().rss;
  let readyAt: number | undefined;
  let firstTranscriptAt: number | undefined;
  let receivedAudioFrame = false;
  let lastAudioLevelAt = Number.NEGATIVE_INFINITY;
  const lifetimeAbort = new AbortController();
  let resolveResult: (transcript: string) => void;
  let rejectResult: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const closeSource = (): Error | undefined => {
    if (source === undefined || sourceClosed) return undefined;
    sourceClosed = true;
    try {
      source.close();
      return undefined;
    } catch (cause) {
      return cause instanceof Error ? cause : new Error(String(cause));
    }
  };
  const observeRss = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  const finish = (value: string | Error) => {
    if (settled) return;
    settled = true;
    lifetimeAbort.abort();
    const closeError = closeSource();
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
    else if (closeError !== undefined) {
      rejectResult(
        createVoiceCaptureError(
          classifyVoiceCaptureError(closeError),
          closeError.message,
          closeError,
        ),
      );
    } else resolveResult(value);
  };

  const finalize = async () => {
    if (settled || finalizing) return;
    if (source === undefined || resampler === undefined) {
      finalizeRequested = true;
      return;
    }
    finalizing = true;
    const closeError = closeSource();
    if (closeError !== undefined) {
      finish(closeError);
      return;
    }
    try {
      const tail = resampler.flush(new Float32Array());
      if (tail.length > 0) {
        chunks.push(tail);
        sampleCount += tail.length;
      }
      const samples = concatenateSamples(chunks, sampleCount);
      const activeDependencies = dependencies ?? {
        runtime: nativeParakeetRuntime(),
      };
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
        finish(
          createVoiceCaptureError(
            "no-audio-frames",
            "I didn't hear a complete instruction. Try again.",
          ),
        );
        return;
      }
      const recognizer = await (recognizerPromise ??
        parakeetRecognizer(
          input,
          activeDependencies.runtime,
          input.dependencies === undefined,
          input.dependencies === undefined,
        ));
      if (settled) return;
      const recognitionStream = recognizer.createStream(
        buildParakeetHotwords(
          resolvedParakeetContextualPhrases(input.contextualPhrases),
          input.paths.tokensPath,
        ),
      );
      recognitionStream.acceptWaveform({ samples, sampleRate: parakeetSampleRate });
      const decoded = await recognizer.decodeAsync(recognitionStream);
      if (settled) return;
      const rawTranscript = decoded.text?.replace(/\s+/gu, " ").trim() ?? "";
      if (rawTranscript.length === 0) {
        finish(
          createVoiceCaptureError(
            "transcription-failed",
            "I didn't hear a complete instruction. Try again.",
          ),
        );
        return;
      }
      firstTranscriptAt = performance.now();
      let transcript = rawTranscript;
      try {
        transcript = input.transformTranscript?.(rawTranscript) ?? rawTranscript;
      } catch {
        // Vocabulary repair is advisory; never discard valid Parakeet output.
      }
      if (settled) return;
      try {
        input.onTranscript?.(transcript);
      } catch {
        // Rendering the final transcript cannot invalidate recognition.
      }
      finish(transcript);
    } catch (cause) {
      const error =
        cause instanceof Error ? cause : new Error("Local Parakeet recognition failed.");
      finish(createVoiceCaptureError(classifyVoiceCaptureError(error), error.message, error));
    }
  };

  const release = () => {
    if (settled || released) return;
    released = true;
    void finalize();
  };

  const feed = (data: Float32Array): void => {
    if (settled || released || resampler === undefined || source === undefined) return;
    if (data.length === 0) return;
    const now = performance.now();
    if (now - lastAudioLevelAt >= AUDIO_LEVEL_INTERVAL_MS) {
      lastAudioLevelAt = now;
      try {
        input.onAudioLevel?.(normalizedAudioRms(data));
      } catch {
        // A presentation callback cannot stop the capture.
      }
    }
    if (!receivedAudioFrame) {
      receivedAudioFrame = true;
      try {
        input.onFirstAudioFrame?.();
      } catch {
        // A presentation callback cannot stop the capture.
      }
    }
    const samples = resampler.resample(interleavedAudioToMono(data, source.channels));
    if (samples.length === 0) return;
    chunks.push(samples.slice());
    sampleCount += samples.length;
  };

  const initialize = (setup: ParakeetPcmCaptureSetup): void => {
    try {
      source = setup.source;
      dependencies = setup.dependencies;
      if (settled) {
        closeSource();
        return;
      }
      if (released) {
        finish(
          createVoiceCaptureError(
            "cancelled",
            "Voice capture stopped before the microphone was ready.",
          ),
        );
        return;
      }
      resampler = new setup.dependencies.runtime.LinearResampler(
        setup.source.sampleRate,
        parakeetSampleRate,
      );
      recognizerPromise = parakeetRecognizer(
        input,
        setup.dependencies.runtime,
        setup.checkResources,
        setup.checkResources,
      );
      void recognizerPromise.catch((cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error("Local Parakeet could not start.");
        finish(createVoiceCaptureError(classifyVoiceCaptureError(error), error.message, error));
      });
      setup.source.start((data) => {
        if (settled || released) return;
        feed(data);
      });
      readyAt = performance.now();
      observeRss();
      try {
        input.onReady?.();
      } catch {
        // A presentation callback cannot stop the capture.
      }
      if (finalizeRequested) void finalize();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Local Parakeet could not start.");
      finish(createVoiceCaptureError(classifyVoiceCaptureError(error), error.message, error));
    }
  };

  if (setupPromise instanceof Promise) {
    void setupPromise.then(initialize, (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error("Local Parakeet could not start.");
      finish(createVoiceCaptureError(classifyVoiceCaptureError(error), error.message, error));
    });
  } else {
    initialize(setupPromise);
  }

  let capture: ParakeetPcmCapture;
  capture = {
    result,
    release,
    cancel: () => finish(createVoiceCaptureError("cancelled", "Voice capture cancelled.")),
    feed,
  };

  return capture;
}

function startParakeetCaptureInternal(input: ParakeetCaptureInput): ParakeetCapture {
  if (!isNativeMicrophonePlatform(input.platform ?? process.platform)) {
    throw new Error("Native Parakeet microphone capture is available on Windows and Linux only.");
  }

  const { dependencies: injectedDependencies, ...captureInput } = input;
  let stream: NativeMicrophoneStream | undefined;
  const activeDependencies = injectedDependencies ?? nativeParakeetDependencies();
  const microphone = activeDependencies.microphone;
  const device = microphone.getDefaultInputDevice();
  const deviceConfig = microphone.getDefaultInputConfig(device.deviceId);
  const setupPromise: ParakeetPcmCaptureSetup = {
    dependencies: { runtime: activeDependencies.runtime },
    checkResources: injectedDependencies === undefined,
    source: {
      sampleRate: deviceConfig.sampleRate,
      channels: deviceConfig.channels,
      start: (onData) => {
        stream = createNativeInputStream(
          microphone,
          device.deviceId,
          {
            sampleRate: deviceConfig.sampleRate,
            channels: deviceConfig.channels,
            sampleFormat: deviceConfig.sampleFormat,
          },
          onData,
        );
      },
      close: () => {
        if (stream === undefined) return;
        microphone.closeStream(stream);
        stream = undefined;
      },
    },
  };

  return startParakeetPcmCaptureInternal(captureInput, setupPromise);
}

/** Captures one explicit push-to-talk utterance and decodes it with Parakeet on release. */
export function startParakeetCapture(input: ParakeetCaptureInput): ParakeetCapture {
  const capture = startParakeetCaptureInternal(input);
  return {
    result: capture.result,
    release: capture.release,
    cancel: capture.cancel,
  };
}

/** Captures externally supplied PCM and decodes it with the same Parakeet lifecycle. */
export function startParakeetPcmCapture(input: ParakeetPcmCaptureInput): ParakeetPcmCapture {
  const setup: ParakeetPcmCaptureSetup = {
    source: {
      sampleRate: input.sampleRate,
      channels: input.channels,
      start: () => undefined,
      close: () => undefined,
    },
    dependencies: input.dependencies ?? { runtime: nativeParakeetRuntime() },
    checkResources: input.dependencies === undefined,
  };
  return startParakeetPcmCaptureInternal(input, setup);
}

export function speakNativeSpeech(text: string, platform = process.platform): Promise<void> {
  if (!isNativeSpeechPlatform(platform) || text.trim().length === 0) return Promise.resolve();
  return kokoroSpeechQueue.enqueue(text).then(() => undefined);
}

/** Reserves acknowledgement order before a local voice task crosses the network. */
export function reserveNativeSpeech(platform = process.platform): SpeechReservation {
  if (!isNativeSpeechPlatform(platform)) {
    return {
      commit: () => Promise.resolve({ status: "not-played", reason: "not-played" }),
      cancel: () => undefined,
    };
  }
  return kokoroSpeechQueue.reserve();
}

/** Whether acknowledgement speech can begin without another worker cold start. */
export function isNativeSpeechReady(platform = process.platform): boolean {
  if (!isNativeSpeechPlatform(platform)) return false;
  const state = kokoroLifecycle.state();
  return state === "ready" || state === "synthesizing";
}

/** Warms Kokoro only after this device has won the Host speaker claim. */
export async function prepareNativeSpeech(platform = process.platform): Promise<void> {
  if (!isNativeSpeechPlatform(platform)) return;
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

/** Capture only needs to barge into audio that is actually playing or queued. */
export function shouldInterruptNativeSpeechForCapture(speechActive: boolean): boolean {
  return speechActive;
}

export async function disposeNativeSpeech(): Promise<void> {
  kokoroSpeechQueue.interrupt();
  await kokoroLifecycle.dispose();
}

const nativeSpeechStderrLimit = 4_096;

const defaultNativeSpeechProcessDependencies: NativeSpeechProcessDependencies = {
  spawn: (command, args) =>
    NodeChildProcess.spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    }) as unknown as NativeSpeechProcess,
  setTimeout: (callback, delayMs) => NodeTimers.setTimeout(callback, delayMs),
  clearTimeout: (timeout) => NodeTimers.clearTimeout(timeout as NodeJS.Timeout),
};

type NativeSpeechPlayer = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

type NativeSpeechAttemptResult =
  | { readonly kind: "success" }
  | { readonly kind: "aborted" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

const linuxNativeSpeechPlayers = (path: string): ReadonlyArray<NativeSpeechPlayer> => [
  { command: "pw-play", args: [path] },
  { command: "paplay", args: [path] },
  { command: "aplay", args: ["-q", path] },
];

function nativeSpeechErrorCode(cause: unknown): string | undefined {
  if (!isRecord(cause) || typeof cause.code !== "string") return undefined;
  return cause.code;
}

function boundedNativeSpeechStderr(stream: NativeSpeechProcess["stderr"]): {
  readonly read: () => string;
  readonly onData: (chunk: unknown) => void;
} {
  let output = "";
  const onData = (chunk: unknown) => {
    if (output.length >= nativeSpeechStderrLimit) return;
    const text = typeof chunk === "string" ? chunk : String(chunk);
    output += text.slice(0, nativeSpeechStderrLimit - output.length);
  };
  stream?.on("data", onData);
  return { read: () => output.trim(), onData };
}

function terminateNativeSpeechProcess(child: NativeSpeechProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
    if (child.killed) finish();
    else {
      try {
        child.kill("SIGKILL");
      } catch {
        finish();
      }
    }
  });
}

async function runNativeSpeechAttempt(
  player: NativeSpeechPlayer,
  signal: AbortSignal | undefined,
  dependencies: NativeSpeechProcessDependencies,
  timeoutMs: number,
): Promise<NativeSpeechAttemptResult> {
  if (signal?.aborted) return { kind: "aborted" };
  let child: NativeSpeechProcess;
  try {
    child = dependencies.spawn(player.command, player.args);
  } catch (cause) {
    if (nativeSpeechErrorCode(cause) === "ENOENT") {
      return { kind: "unavailable", detail: `${player.command} is not installed.` };
    }
    return {
      kind: "failed",
      detail: `${player.command} could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const stderr = boundedNativeSpeechStderr(child.stderr);
  return await new Promise<NativeSpeechAttemptResult>((resolve) => {
    let settled = false;
    let terminationReason: "aborted" | "timeout" | undefined;
    let timeoutHandle: unknown;
    const onExit = (...args: Array<unknown>) => {
      if (terminationReason !== undefined) {
        finish({ kind: terminationReason });
        return;
      }
      if (args[0] === 0) {
        finish({ kind: "success" });
        return;
      }
      const code = args[0] === null || args[0] === undefined ? "unknown" : String(args[0]);
      finish({
        kind: "failed",
        detail: `${player.command} exited with ${code}${stderr.read() ? `: ${stderr.read()}` : "."}`,
      });
    };
    const onError = (cause: unknown) => {
      if (terminationReason !== undefined) {
        finish({ kind: terminationReason });
        return;
      }
      if (nativeSpeechErrorCode(cause) === "ENOENT") {
        finish({ kind: "unavailable", detail: `${player.command} is not installed.` });
        return;
      }
      finish({
        kind: "failed",
        detail: `${player.command} could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    };
    const cleanup = () => {
      if (timeoutHandle !== undefined) dependencies.clearTimeout?.(timeoutHandle);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      child.stderr?.removeListener("data", stderr.onData);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: NativeSpeechAttemptResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      if (settled || terminationReason !== undefined) return;
      terminationReason = "aborted";
      void terminateNativeSpeechProcess(child).then(() => finish({ kind: "aborted" }));
    };
    child.once("exit", onExit);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutHandle = dependencies.setTimeout?.(() => {
      if (settled || terminationReason !== undefined) return;
      terminationReason = "timeout";
      void terminateNativeSpeechProcess(child).then(() => finish({ kind: "timeout" }));
    }, timeoutMs);
    if (signal?.aborted) onAbort();
  });
}

export async function playNativeCue(
  path: string,
  platform = process.platform,
  signal?: AbortSignal,
  dependencies: NativeSpeechProcessDependencies = defaultNativeSpeechProcessDependencies,
): Promise<void> {
  if (platform === "win32") {
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
    return;
  }
  if (platform === "linux") {
    const failures: Array<string> = [];
    for (const player of linuxNativeSpeechPlayers(path)) {
      const result = await runNativeSpeechAttempt(
        player,
        signal,
        dependencies,
        nativeAudioPlaybackTimeoutMs,
      );
      if (result.kind === "success" || result.kind === "aborted") return;
      if (result.kind === "timeout") {
        throw new Error("Jarvis voice playback took too long.");
      }
      failures.push(`${player.command}: ${result.detail}`);
    }
    throw new Error(
      `Jarvis voice playback failed: no supported Linux audio player succeeded. ${failures.join(" ")}`,
    );
  }
  if (platform === "darwin") {
    const result = await runNativeSpeechAttempt(
      { command: "/usr/bin/afplay", args: [path] },
      signal,
      dependencies,
      nativeAudioPlaybackTimeoutMs,
    );
    if (result.kind === "success" || result.kind === "aborted") return;
    if (result.kind === "timeout") throw new Error("Jarvis voice playback took too long.");
    throw new Error(`Jarvis voice playback failed: afplay ${result.detail}`);
  }
}

export const nativeAudioPlaybackTimeoutMs = 120_000;
