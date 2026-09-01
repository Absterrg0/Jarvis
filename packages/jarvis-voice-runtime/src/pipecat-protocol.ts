/** Private, versioned protocol between the desktop voice worker and Pipecat. */
export const DESKTOP_PIPECAT_PROTOCOL_VERSION = 3;
export const DESKTOP_PIPECAT_MAX_LINE_BYTES = 64 * 1024;

// Base64 expands two bytes of PCM to roughly 2.67 bytes. Leave room for the
// JSON envelope and capture metadata so every line stays below the hard cap.
export const DESKTOP_PIPECAT_PCM_CHUNK_BYTES = 45_000;
export const DESKTOP_PIPECAT_MAX_SYNTHESIS_TEXT_LENGTH = 32_000;

export type DesktopPipecatCommand =
  | {
      readonly type: "capture-start";
      readonly requestId: string;
      readonly captureId: string;
      readonly sampleRate: number;
      readonly channels: number;
      readonly contextualPhrases: ReadonlyArray<string>;
    }
  | {
      readonly type: "pcm";
      readonly requestId: string;
      readonly captureId: string;
      readonly sequence: number;
      readonly sampleRate: number;
      readonly channels: number;
      readonly data: string;
    }
  | { readonly type: "capture-release"; readonly requestId: string; readonly captureId: string }
  | { readonly type: "capture-cancel"; readonly requestId: string; readonly captureId: string }
  | { readonly type: "speech-prepare"; readonly requestId: string }
  | { readonly type: "listening-prepare"; readonly requestId: string }
  | {
      readonly type: "speech-start";
      readonly requestId: string;
      readonly speechId: string;
      readonly text: string;
    }
  | { readonly type: "speech-cancel"; readonly requestId: string; readonly speechId: string }
  | {
      readonly type: "synthesis-start";
      readonly requestId: string;
      readonly synthesisId: string;
      readonly text: string;
    }
  | { readonly type: "synthesis-cancel"; readonly requestId: string; readonly synthesisId: string }
  | { readonly type: "shutdown"; readonly requestId: string };

export type DesktopPipecatTiming = {
  readonly engineId: "pipecat-parakeet-tdt-ctc-110m-int8";
  readonly captureId: string;
  readonly start: "cold" | "warm";
  readonly modelLoadMs: number;
  readonly pipelineReadyMs: number;
  readonly firstAudioMs: number;
  readonly captureMs: number;
  readonly audioDurationMs: number;
  readonly releaseToTranscriptMs: number;
  readonly resampleMs: number;
  readonly decodeMs: number;
  readonly totalMs: number;
  readonly audioBytes: number;
  readonly chunkCount: number;
  readonly peakRssBytes: number;
  readonly currentRssBytes?: number;
};

export type DesktopPipecatSpeechTiming = {
  readonly engineId: "kokoro-int8";
  readonly start: "cold" | "warm";
  readonly warmupMs: number;
  readonly firstPlaybackStartMs?: number;
  readonly firstChunkReadyMs?: number;
  readonly synthesisMs: number;
  readonly totalMs: number;
  readonly synthesisCpuMs: number;
  readonly peakRssBytes: number;
  readonly currentRssBytes?: number;
  readonly chunkCount: number;
};

export type DesktopPipecatMessage =
  | { readonly type: "ready"; readonly version: number }
  | { readonly type: "capture-ready"; readonly captureId: string }
  | { readonly type: "transcript"; readonly captureId: string; readonly text: string }
  | {
      readonly type: "capture-result";
      readonly captureId: string;
      readonly ok: true;
      readonly text: string;
    }
  | {
      readonly type: "capture-result";
      readonly captureId: string;
      readonly ok: false;
      readonly message: string;
      readonly code?: string;
    }
  | { readonly type: "stt-timing"; readonly timing: DesktopPipecatTiming }
  | {
      readonly type: "speech-result";
      readonly speechId: string;
      readonly status: "completed" | "interrupted" | "failure";
      readonly message?: string;
      readonly code?: string;
      readonly timing?: DesktopPipecatSpeechTiming;
    }
  | {
      readonly type: "synthesis-audio";
      readonly synthesisId: string;
      readonly sequence: number;
      readonly sampleRate: number;
      readonly channels: 1;
      readonly data: string;
    }
  | {
      readonly type: "synthesis-result";
      readonly synthesisId: string;
      readonly ok: true;
      readonly sampleRate: number;
      readonly channels: 1;
      readonly audioBytes: number;
      readonly timing?: DesktopPipecatSpeechTiming;
    }
  | {
      readonly type: "synthesis-result";
      readonly synthesisId: string;
      readonly ok: false;
      readonly message: string;
      readonly code?: string;
    }
  | { readonly type: "result"; readonly requestId: string; readonly ok: true }
  | {
      readonly type: "result";
      readonly requestId: string;
      readonly ok: false;
      readonly message: string;
      readonly code?: string;
    }
  | { readonly type: "error"; readonly message: string; readonly captureId?: string }
  | { readonly type: "fatal"; readonly message: string };

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCaptureId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

const isSpeechId = isCaptureId;

export function parseDesktopPipecatMessage(value: unknown): DesktopPipecatMessage | null {
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "ready" && candidate.version === DESKTOP_PIPECAT_PROTOCOL_VERSION) {
    return { type: "ready", version: candidate.version };
  }
  if (candidate.type === "capture-ready" && isCaptureId(candidate.captureId)) {
    return { type: "capture-ready", captureId: candidate.captureId };
  }
  if (
    candidate.type === "transcript" &&
    isCaptureId(candidate.captureId) &&
    typeof candidate.text === "string"
  ) {
    return { type: "transcript", captureId: candidate.captureId, text: candidate.text };
  }
  if (candidate.type === "capture-result" && isCaptureId(candidate.captureId)) {
    if (candidate.ok === true && typeof candidate.text === "string") {
      return {
        type: "capture-result",
        captureId: candidate.captureId,
        ok: true,
        text: candidate.text,
      };
    }
    if (candidate.ok === false && typeof candidate.message === "string") {
      return {
        type: "capture-result",
        captureId: candidate.captureId,
        ok: false,
        message: candidate.message,
        ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
      };
    }
  }
  if (candidate.type === "stt-timing" && isDesktopPipecatTiming(candidate.timing)) {
    return { type: "stt-timing", timing: candidate.timing };
  }
  if (candidate.type === "speech-result" && isSpeechId(candidate.speechId)) {
    if (
      (candidate.status === "completed" || candidate.status === "interrupted") &&
      (candidate.message === undefined || typeof candidate.message === "string") &&
      (candidate.code === undefined || typeof candidate.code === "string") &&
      (candidate.timing === undefined || isNativeSpeechTiming(candidate.timing))
    ) {
      return {
        type: "speech-result",
        speechId: candidate.speechId,
        status: candidate.status,
        ...(candidate.message === undefined ? {} : { message: candidate.message }),
        ...(candidate.code === undefined ? {} : { code: candidate.code }),
        ...(candidate.timing === undefined ? {} : { timing: candidate.timing }),
      };
    }
    if (
      candidate.status === "failure" &&
      typeof candidate.message === "string" &&
      (candidate.timing === undefined || isNativeSpeechTiming(candidate.timing))
    ) {
      return {
        type: "speech-result",
        speechId: candidate.speechId,
        status: "failure",
        message: candidate.message,
        ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
        ...(candidate.timing === undefined ? {} : { timing: candidate.timing }),
      };
    }
  }
  if (candidate.type === "synthesis-audio" && isSpeechId(candidate.synthesisId)) {
    if (
      typeof candidate.sequence === "number" &&
      Number.isInteger(candidate.sequence) &&
      isFiniteNonNegative(candidate.sampleRate) &&
      Number.isInteger(candidate.sampleRate) &&
      candidate.sampleRate > 0 &&
      candidate.channels === 1 &&
      typeof candidate.data === "string"
    ) {
      return {
        type: "synthesis-audio",
        synthesisId: candidate.synthesisId,
        sequence: candidate.sequence,
        sampleRate: candidate.sampleRate,
        channels: 1,
        data: candidate.data,
      };
    }
  }
  if (candidate.type === "synthesis-result" && isSpeechId(candidate.synthesisId)) {
    if (
      candidate.ok === true &&
      isFiniteNonNegative(candidate.sampleRate) &&
      Number.isInteger(candidate.sampleRate) &&
      candidate.sampleRate > 0 &&
      candidate.channels === 1 &&
      isFiniteNonNegative(candidate.audioBytes) &&
      Number.isInteger(candidate.audioBytes) &&
      (candidate.timing === undefined || isNativeSpeechTiming(candidate.timing))
    ) {
      return {
        type: "synthesis-result",
        synthesisId: candidate.synthesisId,
        ok: true,
        sampleRate: candidate.sampleRate,
        channels: 1,
        audioBytes: candidate.audioBytes,
        ...(candidate.timing === undefined ? {} : { timing: candidate.timing }),
      };
    }
    if (
      candidate.ok === false &&
      typeof candidate.message === "string" &&
      (candidate.code === undefined || typeof candidate.code === "string")
    ) {
      return {
        type: "synthesis-result",
        synthesisId: candidate.synthesisId,
        ok: false,
        message: candidate.message,
        ...(candidate.code === undefined ? {} : { code: candidate.code }),
      };
    }
  }
  if (candidate.type === "result" && typeof candidate.requestId === "string") {
    if (candidate.ok === true) return { type: "result", requestId: candidate.requestId, ok: true };
    if (candidate.ok === false && typeof candidate.message === "string") {
      return {
        type: "result",
        requestId: candidate.requestId,
        ok: false,
        message: candidate.message,
        ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
      };
    }
  }
  if (candidate.type === "error" && typeof candidate.message === "string") {
    return {
      type: "error",
      message: candidate.message,
      ...(isCaptureId(candidate.captureId) ? { captureId: candidate.captureId } : {}),
    };
  }
  if (candidate.type === "fatal" && typeof candidate.message === "string") {
    return { type: "fatal", message: candidate.message };
  }
  return null;
}

function isDesktopPipecatTiming(value: unknown): value is DesktopPipecatTiming {
  if (typeof value !== "object" || value === null) return false;
  const timing = value as Record<string, unknown>;
  return (
    timing.engineId === "pipecat-parakeet-tdt-ctc-110m-int8" &&
    isCaptureId(timing.captureId) &&
    (timing.start === "cold" || timing.start === "warm") &&
    isFiniteNonNegative(timing.modelLoadMs) &&
    isFiniteNonNegative(timing.pipelineReadyMs) &&
    isFiniteNonNegative(timing.firstAudioMs) &&
    isFiniteNonNegative(timing.captureMs) &&
    isFiniteNonNegative(timing.audioDurationMs) &&
    isFiniteNonNegative(timing.releaseToTranscriptMs) &&
    isFiniteNonNegative(timing.resampleMs) &&
    isFiniteNonNegative(timing.decodeMs) &&
    isFiniteNonNegative(timing.totalMs) &&
    isFiniteNonNegative(timing.audioBytes) &&
    Number.isInteger(timing.audioBytes) &&
    isFiniteNonNegative(timing.chunkCount) &&
    Number.isInteger(timing.chunkCount) &&
    isFiniteNonNegative(timing.peakRssBytes) &&
    Number.isInteger(timing.peakRssBytes) &&
    (timing.currentRssBytes === undefined ||
      (isFiniteNonNegative(timing.currentRssBytes) && Number.isInteger(timing.currentRssBytes)))
  );
}

function isNativeSpeechTiming(value: unknown): value is DesktopPipecatSpeechTiming {
  if (typeof value !== "object" || value === null) return false;
  const timing = value as Partial<DesktopPipecatSpeechTiming>;
  return (
    timing.engineId === "kokoro-int8" &&
    (timing.start === "cold" || timing.start === "warm") &&
    isFiniteNonNegative(timing.warmupMs) &&
    (timing.firstPlaybackStartMs === undefined ||
      isFiniteNonNegative(timing.firstPlaybackStartMs)) &&
    (timing.firstChunkReadyMs === undefined || isFiniteNonNegative(timing.firstChunkReadyMs)) &&
    isFiniteNonNegative(timing.synthesisMs) &&
    isFiniteNonNegative(timing.totalMs) &&
    isFiniteNonNegative(timing.synthesisCpuMs) &&
    isFiniteNonNegative(timing.peakRssBytes) &&
    Number.isInteger(timing.peakRssBytes) &&
    (timing.currentRssBytes === undefined ||
      (isFiniteNonNegative(timing.currentRssBytes) && Number.isInteger(timing.currentRssBytes))) &&
    isFiniteNonNegative(timing.chunkCount) &&
    Number.isInteger(timing.chunkCount)
  );
}

export function encodeDesktopPipecatCommand(command: DesktopPipecatCommand): string {
  const line = JSON.stringify(command);
  if (Buffer.byteLength(line, "utf8") > DESKTOP_PIPECAT_MAX_LINE_BYTES) {
    throw new Error("Pipecat protocol line exceeds 64 KiB.");
  }
  return `${line}\n`;
}

/** Converts renderer/native float PCM into bounded signed 16-bit PCM chunks. */
export function floatPcmToInt16Chunks(samples: Float32Array, channels = 1): ReadonlyArray<Buffer> {
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error("PCM channel count must be a positive integer.");
  }
  if (samples.length % channels !== 0) {
    throw new Error("PCM samples must contain complete channel frames.");
  }
  const maximumSamples = Math.floor(DESKTOP_PIPECAT_PCM_CHUNK_BYTES / 2);
  const samplesPerChunk = Math.floor(maximumSamples / channels) * channels;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < samples.length; offset += samplesPerChunk) {
    const length = Math.min(samplesPerChunk, samples.length - offset);
    const bytes = Buffer.allocUnsafe(length * 2);
    for (let index = 0; index < length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[offset + index] ?? 0));
      bytes.writeInt16LE(
        sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767),
        index * 2,
      );
    }
    chunks.push(bytes);
  }
  return chunks;
}

export function isDesktopPipecatCaptureMessageFor(
  message: Extract<DesktopPipecatMessage, { readonly captureId: string }>,
  captureId: string,
): boolean {
  return message.captureId === captureId;
}
