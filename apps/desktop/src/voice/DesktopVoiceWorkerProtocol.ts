import {
  isVoiceCaptureErrorCode,
  type NativeSpeechTiming,
  type VoiceCaptureErrorCode,
} from "@t3tools/jarvis-native-voice";

/**
 * The desktop voice worker speaks a deliberately small JSON-lines protocol.
 * Keeping this contract independent from Electron IPC makes the worker easy
 * to smoke-test with the same Electron executable used by the packaged app.
 */
export type DesktopVoiceCapturePurpose = "command" | "diagnostic";

export type DesktopVoiceWorkerCommand =
  | { readonly type: "prepare"; readonly requestId: string }
  | { readonly type: "prepare-speech"; readonly requestId: string }
  | { readonly type: "play-acknowledgement"; readonly requestId: string }
  | {
      readonly type: "capture-start";
      readonly requestId: string;
      readonly purpose?: DesktopVoiceCapturePurpose;
      readonly captureId?: string;
      readonly source?: DesktopVoiceWorkerCaptureSource;
      readonly contextualPhrases?: ReadonlyArray<string>;
    }
  | { readonly type: "capture-release"; readonly requestId: string }
  | { readonly type: "capture-cancel"; readonly requestId: string }
  | { readonly type: "speak"; readonly requestId: string; readonly text: string }
  | { readonly type: "interrupt"; readonly requestId: string }
  | { readonly type: "shutdown"; readonly requestId: string };

export type DesktopVoiceWorkerCaptureSource =
  | { readonly type: "native" }
  | {
      readonly type: "renderer-pcm";
      readonly sessionId: string;
      readonly generation: number;
      readonly sampleRate: number;
      readonly channels: number;
    };

export type DesktopVoiceWorkerRendererPcmMessage = {
  readonly type: "renderer-pcm";
  readonly sessionId: string;
  readonly generation: number;
  readonly samples: Float32Array;
};

export type DesktopVoiceWorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "state"; readonly state: DesktopVoiceWorkerState }
  | {
      readonly type: "capture-ready";
      readonly sessionId?: string;
      readonly generation?: number;
      readonly purpose?: DesktopVoiceCapturePurpose;
      readonly captureId?: string;
    }
  | {
      readonly type: "transcript";
      readonly text: string;
      readonly purpose?: DesktopVoiceCapturePurpose;
      readonly captureId?: string;
    }
  | { readonly type: "level"; readonly level: number }
  | { readonly type: "speech-timing"; readonly timing: NativeSpeechTiming }
  | {
      readonly type: "capture-result";
      readonly ok: true;
      readonly text: string;
      readonly purpose?: DesktopVoiceCapturePurpose;
      readonly captureId?: string;
    }
  | {
      readonly type: "capture-result";
      readonly ok: false;
      readonly message: string;
      readonly code?: VoiceCaptureErrorCode;
      readonly purpose?: DesktopVoiceCapturePurpose;
      readonly captureId?: string;
    }
  | { readonly type: "error"; readonly message: string; readonly code?: VoiceCaptureErrorCode }
  | { readonly type: "result"; readonly requestId: string; readonly ok: true }
  | {
      readonly type: "result";
      readonly requestId: string;
      readonly ok: false;
      readonly message: string;
      readonly code?: VoiceCaptureErrorCode;
    }
  | { readonly type: "fatal"; readonly message: string; readonly code?: string };

export type DesktopVoiceWorkerState =
  | "starting"
  | "ready"
  | "capturing"
  | "transcribing"
  | "speaking"
  | "error";

export function parseDesktopVoiceWorkerMessage(value: unknown): DesktopVoiceWorkerMessage | null {
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "ready") return { type: "ready" };
  if (candidate.type === "capture-ready") {
    const sessionId = candidate.sessionId;
    const generation = candidate.generation;
    if (sessionId === undefined && generation === undefined) {
      return { type: "capture-ready", ...parseDesktopVoiceCaptureIdentity(candidate) };
    }
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      typeof generation !== "number" ||
      !Number.isInteger(generation) ||
      generation <= 0
    ) {
      return null;
    }
    return {
      type: "capture-ready",
      sessionId,
      generation,
      ...parseDesktopVoiceCaptureIdentity(candidate),
    };
  }
  if (candidate.type === "transcript" && typeof candidate.text === "string") {
    return {
      type: "transcript",
      text: candidate.text,
      ...parseDesktopVoiceCaptureIdentity(candidate),
    };
  }
  if (
    candidate.type === "level" &&
    typeof candidate.level === "number" &&
    Number.isFinite(candidate.level) &&
    candidate.level >= 0 &&
    candidate.level <= 1
  ) {
    return { type: "level", level: candidate.level };
  }
  if (candidate.type === "speech-timing" && isNativeSpeechTiming(candidate.timing)) {
    return { type: "speech-timing", timing: candidate.timing };
  }
  if (candidate.type === "capture-result") {
    if (candidate.ok === true && typeof candidate.text === "string") {
      return {
        type: "capture-result",
        ok: true,
        text: candidate.text,
        ...parseDesktopVoiceCaptureIdentity(candidate),
      };
    }
    if (candidate.ok === false && typeof candidate.message === "string") {
      return {
        type: "capture-result",
        ok: false,
        message: candidate.message,
        ...(isVoiceCaptureErrorCode(candidate.code) ? { code: candidate.code } : {}),
        ...parseDesktopVoiceCaptureIdentity(candidate),
      };
    }
  }
  if (candidate.type === "error" && typeof candidate.message === "string") {
    return {
      type: "error",
      message: candidate.message,
      ...(isVoiceCaptureErrorCode(candidate.code) ? { code: candidate.code } : {}),
    };
  }
  if (
    candidate.type === "state" &&
    (candidate.state === "starting" ||
      candidate.state === "ready" ||
      candidate.state === "capturing" ||
      candidate.state === "transcribing" ||
      candidate.state === "speaking" ||
      candidate.state === "error")
  ) {
    return { type: "state", state: candidate.state };
  }
  if (candidate.type === "fatal" && typeof candidate.message === "string") {
    return {
      type: "fatal",
      message: candidate.message,
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    };
  }
  if (candidate.type === "result" && typeof candidate.requestId === "string") {
    if (candidate.ok === true) return { type: "result", requestId: candidate.requestId, ok: true };
    if (candidate.ok === false && typeof candidate.message === "string") {
      return {
        type: "result",
        requestId: candidate.requestId,
        ok: false,
        message: candidate.message,
        ...(isVoiceCaptureErrorCode(candidate.code) ? { code: candidate.code } : {}),
      };
    }
  }
  return null;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNativeSpeechTiming(value: unknown): value is NativeSpeechTiming {
  if (typeof value !== "object" || value === null) return false;
  const timing = value as Partial<NativeSpeechTiming>;
  return (
    timing.engineId === "kokoro-int8" &&
    (timing.start === "cold" || timing.start === "warm") &&
    isNonNegativeFinite(timing.warmupMs) &&
    (timing.firstPlaybackStartMs === undefined ||
      isNonNegativeFinite(timing.firstPlaybackStartMs)) &&
    (timing.firstChunkReadyMs === undefined || isNonNegativeFinite(timing.firstChunkReadyMs)) &&
    isNonNegativeFinite(timing.synthesisMs) &&
    isNonNegativeFinite(timing.totalMs) &&
    isNonNegativeFinite(timing.synthesisCpuMs) &&
    isNonNegativeFinite(timing.peakRssBytes) &&
    Number.isInteger(timing.chunkCount) &&
    (timing.chunkCount ?? -1) >= 0
  );
}

export function parseDesktopVoiceWorkerCaptureSource(
  value: unknown,
): DesktopVoiceWorkerCaptureSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "native") return { type: "native" };
  if (
    candidate.type === "renderer-pcm" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.generation === "number" &&
    Number.isInteger(candidate.generation) &&
    candidate.generation > 0 &&
    typeof candidate.sampleRate === "number" &&
    Number.isFinite(candidate.sampleRate) &&
    candidate.sampleRate > 0 &&
    typeof candidate.channels === "number" &&
    Number.isInteger(candidate.channels) &&
    candidate.channels > 0
  ) {
    return {
      type: "renderer-pcm",
      sessionId: candidate.sessionId,
      generation: candidate.generation,
      sampleRate: candidate.sampleRate,
      channels: candidate.channels,
    };
  }
  return undefined;
}

export function parseDesktopVoiceWorkerRendererPcmMessage(
  value: unknown,
): DesktopVoiceWorkerRendererPcmMessage | null {
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "renderer-pcm" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.generation !== "number" ||
    !Number.isInteger(candidate.generation) ||
    candidate.generation <= 0 ||
    !(candidate.samples instanceof Float32Array)
  ) {
    return null;
  }
  return {
    type: "renderer-pcm",
    sessionId: candidate.sessionId,
    generation: candidate.generation,
    samples: candidate.samples,
  };
}

export function isDesktopVoiceWorkerRendererPcmCurrent(
  message: DesktopVoiceWorkerRendererPcmMessage,
  sessionId: string | undefined,
  generation: number | undefined,
): boolean {
  return message.sessionId === sessionId && message.generation === generation;
}

export function canDesktopVoiceWorkerSpeak(input: {
  readonly captureActive: boolean;
  readonly captureGeneration: number;
  readonly speechGeneration: number;
}): boolean {
  return !input.captureActive && input.captureGeneration === input.speechGeneration;
}

export function parseDesktopVoiceCapturePurpose(
  value: unknown,
): DesktopVoiceCapturePurpose | undefined {
  return value === "command" || value === "diagnostic" ? value : undefined;
}

export function parseDesktopVoiceCaptureIdentity(value: Record<string, unknown>): {
  readonly purpose?: DesktopVoiceCapturePurpose;
  readonly captureId?: string;
} {
  const purpose = parseDesktopVoiceCapturePurpose(value.purpose);
  const captureId =
    typeof value.captureId === "string" && value.captureId.length > 0 ? value.captureId : undefined;
  return {
    ...(purpose === undefined ? {} : { purpose }),
    ...(captureId === undefined ? {} : { captureId }),
  };
}

export type DesktopVoiceCaptureStartInput =
  | DesktopVoiceWorkerCaptureSource
  | {
      readonly purpose?: DesktopVoiceCapturePurpose;
      readonly captureId?: string;
      readonly source?: DesktopVoiceWorkerCaptureSource;
      readonly contextualPhrases?: ReadonlyArray<string>;
    };

export function isDesktopVoiceWorkerCaptureSource(
  value: object,
): value is DesktopVoiceWorkerCaptureSource {
  return "type" in value && (value.type === "native" || value.type === "renderer-pcm");
}

export function normalizeDesktopVoiceCaptureStart(
  input: DesktopVoiceCaptureStartInput | undefined,
  allocateCaptureId: () => string,
): {
  readonly purpose: DesktopVoiceCapturePurpose;
  readonly captureId: string;
  readonly source: DesktopVoiceWorkerCaptureSource;
  readonly contextualPhrases: ReadonlyArray<string>;
} {
  if (input === undefined) {
    return {
      purpose: "command",
      captureId: allocateCaptureId(),
      source: { type: "native" },
      contextualPhrases: [],
    };
  }
  if (isDesktopVoiceWorkerCaptureSource(input)) {
    return {
      purpose: "command",
      captureId: allocateCaptureId(),
      source: input,
      contextualPhrases: [],
    };
  }
  return {
    purpose: input.purpose ?? "command",
    captureId:
      input.captureId !== undefined && input.captureId.length > 0
        ? input.captureId
        : allocateCaptureId(),
    source: input.source ?? { type: "native" },
    contextualPhrases: normalizeDesktopVoiceContextualPhrases(input.contextualPhrases),
  };
}

export function normalizeDesktopVoiceContextualPhrases(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((phrase): phrase is string => typeof phrase === "string")
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase.length > 0 && phrase.length <= 100),
    ),
  ].slice(0, 64);
}
