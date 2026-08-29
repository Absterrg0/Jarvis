// oxlint-disable t3code/no-global-process-runtime -- this is the narrow Desktop native boundary.
// @effect-diagnostics nodeBuiltinImport:off globalProcess:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeTimers from "node:timers";
import * as NodeTimersPromises from "node:timers/promises";

import { createSpeechArbiter } from "./speech-arbiter.ts";
export {
  classifyVoiceCaptureError,
  createVoiceCaptureError,
  isVoiceCaptureErrorCode,
  voiceCaptureErrorCodes,
} from "./voice-capture-error.ts";
export type { VoiceCaptureError, VoiceCaptureErrorCode } from "./voice-capture-error.ts";
export {
  createNodeCpalSpeechOutput,
  type NodeCpalSpeechOutput,
  type NodeCpalSpeechOutputRuntime,
} from "./node-cpal-speech-output.ts";

export type NativeSpeechInterruptSource = "tray" | "overlay" | "capture" | "relay";

export type NativeSpeechTiming = {
  readonly engineId: "kokoro-int8";
  readonly start: "cold" | "warm";
  readonly warmupMs: number;
  /** Time until the first audio buffer is handed to the device adapter, not DAC onset. */
  readonly firstPlaybackStartMs?: number;
  readonly firstChunkReadyMs?: number;
  readonly synthesisMs: number;
  readonly totalMs: number;
  readonly synthesisCpuMs: number;
  readonly peakRssBytes: number;
  readonly chunkCount: number;
};

export type LatestSpeechQueue = ReturnType<typeof createSpeechArbiter>;
export type { SpeechReservation } from "./speech-arbiter.ts";

export function createLatestSpeechQueue(
  speak: (text: string, signal: AbortSignal) => Promise<void>,
  onIdle?: () => void,
): LatestSpeechQueue {
  return createSpeechArbiter(speak, onIdle);
}

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

export type NativeMicrophoneStream = string;

export type NativeMicrophone = {
  readonly getHosts: () => ReadonlyArray<NativeMicrophoneHost>;
  readonly getDevices: (hostId?: string) => ReadonlyArray<NativeMicrophoneDevice>;
  readonly getDefaultInputDevice: () => NativeMicrophoneDevice;
  readonly getDefaultInputConfig: (deviceId: string) => NativeMicrophoneStreamConfig;
  readonly createStream: (
    deviceId: string,
    isInput: boolean,
    config: NativeMicrophoneStreamConfig,
    onData?: (data: Float32Array) => void,
  ) => NativeMicrophoneStream;
  readonly closeStream: (stream: NativeMicrophoneStream) => void;
};

const require = NodeModule.createRequire(import.meta.url);
const nativeMicrophoneContract = [
  "getDefaultInputDevice",
  "getDefaultInputConfig",
  "createStream",
  "closeStream",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateNativeMicrophone(value: unknown): NativeMicrophone {
  if (!isRecord(value)) throw new Error("Packaged node-cpal did not load an object.");
  const missing = nativeMicrophoneContract.find((name) => typeof value[name] !== "function");
  if (missing !== undefined) {
    throw new Error(`Packaged node-cpal is missing required function ${missing}.`);
  }
  return value as unknown as NativeMicrophone;
}

export function loadNativeMicrophone(): NativeMicrophone {
  return validateNativeMicrophone(require("node-cpal"));
}

export function isNativeMicrophonePlatform(platform: string = process.platform): boolean {
  return platform === "win32" || platform === "linux";
}

export function prepareNativeMicrophone(platform = process.platform): void {
  if (!isNativeMicrophonePlatform(platform)) return;
  loadNativeMicrophone();
}

export function normalizedAudioRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.min(1, Math.sqrt(total / samples.length));
}

const AUDIO_LEVEL_INTERVAL_MS = 90;

export type NativePcmCaptureInput = {
  readonly onReady?: () => void;
  readonly onFirstAudioFrame?: () => void;
  readonly onAudioLevel?: (level: number) => void;
  readonly onAudioFrame?: (input: {
    readonly samples: Float32Array;
    readonly sampleRate: number;
    readonly channels: number;
  }) => void;
  readonly dependencies?: Pick<{ readonly microphone: NativeMicrophone }, "microphone">;
  readonly platform?: string;
};

export type NativePcmCapture = {
  readonly sampleRate: number;
  readonly channels: number;
  release(): void;
  cancel(): void;
};

export function startNativePcmCapture(input: NativePcmCaptureInput): NativePcmCapture {
  if (!isNativeMicrophonePlatform(input.platform ?? process.platform)) {
    throw new Error("Native microphone capture is available on Windows and Linux only.");
  }
  const microphone = input.dependencies?.microphone ?? loadNativeMicrophone();
  const device = microphone.getDefaultInputDevice();
  const config = microphone.getDefaultInputConfig(device.deviceId);
  let stream: NativeMicrophoneStream | undefined;
  let active = true;
  let receivedAudioFrame = false;
  let lastAudioLevelAt = Number.NEGATIVE_INFINITY;
  const onData = (samples: Float32Array): void => {
    if (!active || samples.length === 0) return;
    const now = performance.now();
    if (!receivedAudioFrame) {
      receivedAudioFrame = true;
      try {
        input.onFirstAudioFrame?.();
      } catch {
        // Presentation callbacks cannot stop capture.
      }
    }
    if (now - lastAudioLevelAt >= AUDIO_LEVEL_INTERVAL_MS) {
      lastAudioLevelAt = now;
      try {
        input.onAudioLevel?.(normalizedAudioRms(samples));
      } catch {
        // Presentation callbacks cannot stop capture.
      }
    }
    try {
      input.onAudioFrame?.({
        samples,
        sampleRate: config.sampleRate,
        channels: config.channels,
      });
    } catch {
      // A downstream transport failure is reported by its own protocol.
    }
  };
  try {
    stream = microphone.createStream(device.deviceId, true, config, onData);
    try {
      input.onReady?.();
    } catch {
      // Presentation callbacks cannot stop capture.
    }
  } catch (cause) {
    active = false;
    throw cause;
  }
  const close = (): void => {
    if (!active) return;
    active = false;
    if (stream === undefined) return;
    const current = stream;
    stream = undefined;
    microphone.closeStream(current);
  };
  return {
    sampleRate: config.sampleRate,
    channels: config.channels,
    release: close,
    cancel: close,
  };
}

export type NativeSpeechProcess = {
  readonly killed: boolean;
  readonly kill: (signal?: string) => boolean;
  readonly once: (event: "error" | "exit", listener: (...args: Array<unknown>) => void) => void;
  readonly removeListener: (
    event: "error" | "exit",
    listener: (...args: Array<unknown>) => void,
  ) => void;
  readonly stderr: {
    readonly on: (event: "data", listener: (chunk: unknown) => void) => void;
    readonly removeListener: (event: "data", listener: (chunk: unknown) => void) => void;
  } | null;
};

export type NativeSpeechProcessDependencies = {
  readonly spawn: (command: string, args: ReadonlyArray<string>) => NativeSpeechProcess;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timeout: unknown) => void;
};

export const nativeAudioPlaybackTimeoutMs = 120_000;
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

type NativeSpeechPlayer = { readonly command: string; readonly args: ReadonlyArray<string> };

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
      if (result.kind === "timeout") throw new Error("Jarvis voice playback took too long.");
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
