// oxlint-disable t3code/no-global-process-runtime -- Desktop owns this native process boundary.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

import type {
  DesktopJarvisVoiceSpeechLane,
  DesktopJarvisVoiceSpeechOutcome,
  DesktopJarvisVoiceState,
  DesktopJarvisVoiceStatus,
} from "@t3tools/contracts";
import {
  createVoiceCaptureError,
  isVoiceCaptureErrorCode,
} from "@t3tools/jarvis-native-voice/desktop-native-voice";
import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import {
  type DesktopVoiceCapturePurpose,
  type DesktopVoiceCaptureStartInput,
  type DesktopVoiceWorkerCommand,
  type DesktopVoiceWorkerCaptureSource,
  type DesktopVoiceWorkerMessage,
  type DesktopVoiceWorkerComputeResult,
  normalizeDesktopVoiceCaptureStart,
  parseDesktopVoiceWorkerMessage,
} from "./DesktopVoiceWorkerProtocol.ts";
import * as IpcChannels from "../ipc/channels.ts";

type VoiceChild = NodeChildProcess.ChildProcess;
type Pending = {
  readonly resolve: (
    value: boolean | DesktopJarvisVoiceSpeechOutcome | DesktopVoiceWorkerComputeResult,
  ) => void;
  readonly reject: (cause: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};
type PendingPcmSend = {
  readonly promise: Promise<boolean>;
  readonly settle: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type DesktopJarvisVoicePcmFrame = {
  readonly sessionId: string;
  readonly generation: number;
  readonly samples: Float32Array;
};

const STARTUP_TIMEOUT_MS = 15_000;
const PCM_SEND_TIMEOUT_MS = 2_000;
// A capture command can include a one-model Parakeet activation after speech.
// The worker stays owned by Desktop while that finishes instead of being
// killed at the old five-second boundary and orphaning its sidecar.
const MODEL_COMMAND_TIMEOUT_MS = 35_000;
const SPEECH_COMMAND_TIMEOUT_MS = 180_000;
const CONTROL_COMMAND_TIMEOUT_MS = 15_000;
const { logInfo: logVoiceInfo } = makeComponentLogger("desktop-jarvis-voice");

const commandTimeout = (type: DesktopVoiceWorkerCommand["type"]): number => {
  if (type === "speak" || type === "remote-synthesize") return SPEECH_COMMAND_TIMEOUT_MS;
  if (
    type === "prepare" ||
    type === "prepare-speech" ||
    type === "capture-start" ||
    type === "capture-release" ||
    type === "capture-cancel" ||
    type === "remote-transcribe"
  ) {
    return MODEL_COMMAND_TIMEOUT_MS;
  }
  return CONTROL_COMMAND_TIMEOUT_MS;
};

const isNativePlatform = (platform: NodeJS.Platform): boolean =>
  platform === "darwin" || platform === "linux" || platform === "win32";

/**
 * Resolves the voice model directory from Desktop's own packaged resources.
 */
export function resolveDesktopJarvisVoiceResourceRoot(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly executablePath: string;
  readonly developmentResourceRoot: string;
  readonly exists?: (path: string) => boolean;
}): string | null {
  const path = input.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const exists = input.exists ?? NodeFS.existsSync;
  const candidates = input.isPackaged
    ? [path.join(input.resourcesPath, "jarvis-resources")]
    : [input.developmentResourceRoot];
  return candidates.find(exists) ?? null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function state(status: DesktopJarvisVoiceStatus, native: boolean, errorCode?: string) {
  return {
    status,
    native,
    ...(errorCode === undefined ? {} : { errorCode }),
  } satisfies DesktopJarvisVoiceState;
}

/** Broadcasts a worker event defensively across renderers during teardown. */
export function broadcastDesktopJarvisVoiceMessage(input: {
  readonly message: DesktopVoiceWorkerMessage;
  readonly native: boolean;
  readonly windows?: readonly Electron.BrowserWindow[];
}): void {
  const send = (window: Electron.BrowserWindow, channel: string, value: unknown): void => {
    try {
      if (!window.isDestroyed()) window.webContents.send(channel, value);
    } catch {
      // A renderer can disappear between isDestroyed and send during quit.
    }
  };
  let windows: readonly Electron.BrowserWindow[];
  try {
    windows = input.windows ?? Electron.BrowserWindow.getAllWindows();
  } catch {
    return;
  }
  for (const window of windows) {
    const message = input.message;
    if (message.type === "state") {
      send(window, IpcChannels.JARVIS_VOICE_STATE_CHANNEL, state(message.state, input.native));
    } else if (message.type === "transcript") {
      send(window, IpcChannels.JARVIS_VOICE_TRANSCRIPT_CHANNEL, {
        text: message.text,
        purpose: message.purpose ?? "command",
        captureId: message.captureId ?? "",
      });
    } else if (message.type === "error") {
      send(window, IpcChannels.JARVIS_VOICE_ERROR_CHANNEL, message.message);
    }
  }
}

export interface DesktopJarvisVoice {
  readonly getState: () => DesktopJarvisVoiceState;
  readonly prepare: () => Promise<DesktopJarvisVoiceState>;
  readonly prepareSpeech: () => Promise<{ readonly accepted: boolean }>;
  readonly playAcknowledgement: () => Promise<{ readonly accepted: boolean }>;
  readonly startCapture: (
    input?: DesktopVoiceWorkerCaptureSource | DesktopVoiceCaptureStartInput,
  ) => Promise<{ readonly accepted: boolean }>;
  readonly pushPcmFrame: (
    frame: DesktopJarvisVoicePcmFrame,
  ) => Promise<{ readonly accepted: boolean }>;
  readonly releaseCapture: () => Promise<{ readonly accepted: boolean }>;
  readonly cancelCapture: () => Promise<{ readonly accepted: boolean }>;
  readonly speak: (
    text: string,
    lane?: DesktopJarvisVoiceSpeechLane,
    deliveryId?: string,
  ) => Promise<DesktopJarvisVoiceSpeechOutcome>;
  readonly cancelSpeech: (deliveryId: string) => Promise<{ readonly accepted: boolean }>;
  readonly interrupt: () => Promise<{ readonly accepted: boolean }>;
  readonly transcribeRemote: (
    input: import("@t3tools/contracts").JarvisVoiceTranscribeInput,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly synthesizeRemote: (
    text: string,
    signal?: AbortSignal,
  ) => Promise<{
    readonly sampleRate: number;
    readonly channels: 1;
    readonly pcmBase64: string;
  }>;
  readonly onState: (listener: (state: DesktopJarvisVoiceState) => void) => () => void;
  readonly onLevel: (listener: (level: number) => void) => () => void;
  readonly stop: () => void;
}

export class DesktopJarvisVoiceService extends Context.Service<
  DesktopJarvisVoiceService,
  DesktopJarvisVoice
>()("@t3tools/desktop/voice/DesktopJarvisVoice/DesktopJarvisVoiceService") {}

export function createDesktopJarvisVoice(input: {
  readonly platform: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly workerPath: string | null;
  readonly resourceRoot: string | null;
  readonly pipecatProjectRoot?: string;
  readonly executablePath?: string;
  readonly spawn?: typeof NodeChildProcess.spawn;
  readonly emit?: (message: DesktopVoiceWorkerMessage) => void;
  readonly startupTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}): DesktopJarvisVoice {
  const native = isNativePlatform(input.platform);
  const captureAvailable =
    (input.platform === "win32" || input.platform === "linux") &&
    (input.architecture ?? process.arch) === "x64";
  const rendererCaptureAvailable = input.platform === "darwin";
  const executablePath = input.executablePath ?? process.execPath;
  const spawn = input.spawn ?? NodeChildProcess.spawn;
  const emit = input.emit ?? (() => undefined);
  let current = state(
    input.workerPath === null || input.resourceRoot === null || !native
      ? "unavailable"
      : "starting",
    native,
  );
  let child: VoiceChild | null = null;
  let startup: Promise<void> | null = null;
  let sequence = 0;
  let stopped = false;
  let restartRequired = false;
  let generation = 0;
  let output = "";
  // Stateful UTF-8 decoding for worker stdout: a multi-byte character can
  // split across pipe chunks, and decoding each chunk alone would corrupt it
  // into replacement characters before JSON parsing. Reset together with the
  // line buffer on every (re)start so a previous generation cannot poison the
  // next transcript.
  let decoder = new NodeStringDecoder.StringDecoder("utf8");
  let localSpeechOperationActive = false;
  let remoteComputeActive = false;
  /** Bumped when capture preempts speech so the superseded send stays silent. */
  let speechEpoch = 0;
  const pending = new Map<string, Pending>();
  const pendingPcmSends = new Set<PendingPcmSend>();
  const commandTimeoutOverride = input.commandTimeoutMs;
  let activeCapture:
    | {
        readonly purpose: DesktopVoiceCapturePurpose;
        readonly captureId: string;
        readonly source: DesktopVoiceWorkerCaptureSource;
      }
    | undefined;
  const stateListeners = new Set<(next: DesktopJarvisVoiceState) => void>();
  const levelListeners = new Set<(level: number) => void>();
  // Bounded shutdown of a retired worker whose handle is already cleared
  // (failAll path). The next start awaits it before spawning a replacement.
  let retiring: Promise<void> | null = null;

  const settlePendingPcmSends = (accepted: boolean): void => {
    for (const pendingPcmSend of pendingPcmSends) {
      clearTimeout(pendingPcmSend.timer);
      pendingPcmSends.delete(pendingPcmSend);
      pendingPcmSend.settle(accepted);
    }
  };

  const setState = (next: DesktopJarvisVoiceState) => {
    if (stopped) return;
    current = next;
    emit({ type: "state", state: next.status === "unavailable" ? "error" : next.status });
    for (const listener of stateListeners) {
      try {
        listener(next);
      } catch {
        // A shell/renderer observer must not affect worker orchestration.
      }
    }
  };

  const failAll = (cause: Error, expectedChild?: VoiceChild) => {
    if (stopped || (expectedChild !== undefined && child !== expectedChild)) return;
    const failedChild = child;
    const captureInFlight = activeCapture !== undefined;
    for (const request of pending.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer);
      request.reject(cause);
    }
    pending.clear();
    activeCapture = undefined;
    settlePendingPcmSends(false);
    child = null;
    startup = null;
    restartRequired = true;
    if (failedChild !== null) {
      // The handle is cleared but the process may still be shutting down.
      // Record its bounded shutdown so the next start observes the exit
      // instead of layering a replacement worker over it.
      retiring = stopOwnedChild(failedChild);
    }
    const captureWasActive = captureInFlight;
    setState(state("error", native, "WORKER_EXITED"));
    if (captureWasActive) {
      emit({
        type: "error",
        message: "Voice capture stopped unexpectedly. Try talking again.",
      });
    }
  };

  const handleMessage = (message: DesktopVoiceWorkerMessage): void => {
    if (message.type === "ready") {
      if (activeCapture !== undefined) return;
      setState(state("ready", native));
      return;
    }
    if (message.type === "state") {
      if (message.state === "ready" && activeCapture !== undefined) {
        return;
      }
      setState(state(message.state, native));
      return;
    }
    if (message.type === "transcript") {
      if (message.captureId !== undefined && message.captureId !== activeCapture?.captureId) return;
      emit({
        ...message,
        purpose: message.purpose ?? activeCapture?.purpose ?? "command",
        captureId: message.captureId ?? activeCapture?.captureId ?? "",
      });
      return;
    }
    if (message.type === "level") {
      for (const listener of levelListeners) {
        try {
          listener(message.level);
        } catch {
          // A waveform observer must not affect worker orchestration.
        }
      }
      return;
    }
    if (message.type === "speech-timing") {
      emit(message);
      return;
    }
    if (message.type === "voice-timing") {
      emit(message);
      return;
    }
    if (message.type === "capture-result") {
      if (message.captureId !== undefined && message.captureId !== activeCapture?.captureId) return;
      activeCapture = undefined;
      if (!message.ok) {
        emit({
          type: "error",
          message: message.message,
          ...(message.code === undefined ? {} : { code: message.code }),
        });
      }
      return;
    }
    if (message.type === "fatal") {
      restartRequired = true;
      emit({
        type: "error",
        message: message.message,
        ...(isVoiceCaptureErrorCode(message.code) ? { code: message.code } : {}),
      });
      setState(state("error", native, message.code ?? "VOICE_UNAVAILABLE"));
      return;
    }
    if (message.type !== "result") return;
    const request = pending.get(message.requestId);
    if (request === undefined) return;
    pending.delete(message.requestId);
    if (request.timer !== undefined) clearTimeout(request.timer);
    if (message.ok)
      request.resolve(message.compute ?? message.outcome ?? message.accepted !== false);
    else
      request.reject(
        message.code === undefined
          ? new Error(message.message)
          : createVoiceCaptureError(message.code, message.message),
      );
  };

  const send = (
    type: DesktopVoiceWorkerCommand["type"],
    extra: Record<string, unknown> = {},
  ): Promise<boolean | DesktopJarvisVoiceSpeechOutcome | DesktopVoiceWorkerComputeResult> => {
    const commandChild = child;
    const commandStdin = commandChild?.stdin;
    if (
      commandChild === null ||
      commandStdin === null ||
      commandStdin === undefined ||
      commandStdin.destroyed
    ) {
      return Promise.reject(new Error("Jarvis native voice worker is not running."));
    }
    const requestId = `voice-${sequence++}`;
    const command = { type, requestId, ...extra };
    return new Promise<boolean | DesktopJarvisVoiceSpeechOutcome | DesktopVoiceWorkerComputeResult>(
      (resolve, reject) => {
        const request: Pending = { resolve, reject };
        pending.set(requestId, request);
        request.timer = setTimeout(
          () => {
            if (pending.get(requestId) !== request) return;
            const timeout = new Error(`Voice worker ${type} command timed out.`);
            failAll(timeout, commandChild);
          },
          commandTimeoutOverride ?? commandTimeout(type),
        );
        commandStdin.write(`${JSON.stringify(command)}\n`, (cause) => {
          if (cause === undefined || cause === null) return;
          pending.delete(requestId);
          if (request.timer !== undefined) clearTimeout(request.timer);
          reject(cause);
        });
      },
    );
  };

  const SHUTDOWN_TIMEOUT_MS = input.shutdownTimeoutMs ?? 2_000;

  // Bounded shutdown for one owned child: SIGTERM, then observed exit, then
  // SIGKILL past the deadline. Resolves exactly once; a child that never
  // reports exit still releases the restart after the deadline.
  const stopOwnedChild = (target: VoiceChild): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        if (typeof target.once === "function") {
          target.once("exit", finish);
          target.once("close", finish);
        }
      } catch {
        finish();
        return;
      }
      if (target.exitCode !== null && target.exitCode !== undefined) {
        finish();
        return;
      }
      try {
        if (!target.killed) target.kill("SIGTERM");
        else finish();
      } catch {
        finish();
        return;
      }
      const timer = setTimeout(() => {
        try {
          if (!done) target.kill("SIGKILL");
        } catch {
          // The child is already gone; the exit handler settles below.
        }
        finish();
      }, SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
    });

  const ensureWorker = async (): Promise<void> => {
    if (stopped) throw new Error("Jarvis native voice worker has been stopped.");
    if (!native || input.workerPath === null || input.resourceRoot === null) {
      throw new Error("Native voice is unavailable on this platform.");
    }
    if (startup !== null) return startup;
    if (child !== null && !restartRequired) return;
    if (child !== null) {
      // A fatal worker message can leave the process alive. Do not layer a
      // second worker over it on Retry: clear its pending requests, observe
      // its exit, and only then replace the handle. The generation bump below
      // keeps late messages from the old worker out of current state.
      const staleChild = child;
      child = null;
      restartRequired = false;
      for (const request of pending.values()) {
        request.reject(new Error("Voice worker restarted."));
      }
      pending.clear();
      await stopOwnedChild(staleChild);
      if (stopped) throw new Error("Jarvis native voice worker has been stopped.");
    }
    if (retiring !== null) {
      // A previous failure cleared the handle without observing the exit.
      // Wait for that bounded shutdown before spawning the replacement,
      // even though child no longer references the retired worker.
      const wait = retiring;
      retiring = null;
      await wait;
      if (stopped) throw new Error("Jarvis native voice worker has been stopped.");
    }
    startup = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        if (child !== null && !child.killed) child.kill("SIGTERM");
        settled = true;
        reject(new Error("Native voice worker did not become ready."));
      }, input.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
      const finish = (cause?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cause === undefined) resolve();
        else reject(cause);
      };
      try {
        output = "";
        decoder = new NodeStringDecoder.StringDecoder("utf8");
        child = spawn(executablePath, [input.workerPath!], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            JARVIS_VOICE_ROOT: input.resourceRoot!,
            JARVIS_KOKORO_ROOT: NodePath.join(input.resourceRoot!, "kokoro"),
            ...(input.pipecatProjectRoot === undefined
              ? {}
              : { JARVIS_PIPECAT_PROJECT_ROOT: input.pipecatProjectRoot }),
          },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          serialization: "advanced",
          windowsHide: true,
        });
        restartRequired = false;
      } catch (cause) {
        finish(new Error(errorMessage(cause)));
        return;
      }
      const activeChild = child;
      const activeGeneration = ++generation;
      activeChild.stdout?.on("data", (chunk: Buffer | string) => {
        if (stopped || child !== activeChild || generation !== activeGeneration) return;
        output += typeof chunk === "string" ? chunk : decoder.write(chunk);
        const lines = output.split(/\r?\n/u);
        output = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const parsed: unknown = JSON.parse(line);
            const message = parseDesktopVoiceWorkerMessage(parsed);
            if (message !== null) {
              handleMessage(message);
              if (message.type === "ready") finish();
              if (message.type === "fatal") finish(new Error(message.message));
            }
          } catch {
            // Keep the protocol line-oriented and ignore diagnostics that do
            // not conform to the worker contract.
          }
        }
      });
      activeChild.stderr?.on("data", () => undefined);
      activeChild.once("error", (cause) => {
        failAll(cause instanceof Error ? cause : new Error(String(cause)), activeChild);
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      });
      activeChild.once("exit", (code) => {
        if (stopped || child !== activeChild || generation !== activeGeneration) return;
        if (!settled) finish(new Error(`Native voice worker exited (${code ?? "unknown"}).`));
        failAll(new Error("Native voice worker exited."), activeChild);
      });
    }).finally(() => {
      startup = null;
    });
    try {
      await startup;
    } catch (cause) {
      setState(state("error", native, "WORKER_START_FAILED"));
      throw cause;
    }
  };

  const command = async (
    type: DesktopVoiceWorkerCommand["type"],
    extra?: Record<string, unknown>,
  ): Promise<{ readonly accepted: boolean }> => {
    try {
      await ensureWorker();
      const accepted = await send(type, extra);
      return {
        accepted:
          typeof accepted === "boolean"
            ? accepted
            : "status" in accepted
              ? accepted.status === "played"
              : true,
      };
    } catch (cause) {
      if (type === "speak" || type === "play-acknowledgement") {
        emit({ type: "error", message: errorMessage(cause) });
      }
      return { accepted: false };
    }
  };

  const runLocalSpeechOperation = async <A>(
    rejected: A,
    operation: () => Promise<A>,
  ): Promise<A> => {
    if (remoteComputeActive || localSpeechOperationActive || activeCapture !== undefined) {
      return rejected;
    }
    localSpeechOperationActive = true;
    try {
      return await operation();
    } finally {
      localSpeechOperationActive = false;
    }
  };

  const runRemoteCompute = async <A>(operation: () => Promise<A>): Promise<A> => {
    if (remoteComputeActive || localSpeechOperationActive || activeCapture !== undefined) {
      throw new Error("Desktop voice is busy with another capture or speech operation.");
    }
    remoteComputeActive = true;
    try {
      return await operation();
    } finally {
      remoteComputeActive = false;
    }
  };

  const sendRemoteCompute = async (
    type: "remote-transcribe" | "remote-synthesize",
    extra: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DesktopVoiceWorkerComputeResult> => {
    await ensureWorker();
    if (signal?.aborted) throw new Error("Desktop voice compute was cancelled.");
    const operationId = `remote-operation-${++sequence}`;
    const result = send(type, { ...extra, operationId });
    const cancel = () => {
      void send("remote-cancel", { operationId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const response = await result;
      if (typeof response === "object" && "operation" in response) return response;
      throw new Error("Voice worker returned an invalid remote compute result.");
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };

  const pushPcmFrame = (
    frame: DesktopJarvisVoicePcmFrame,
  ): Promise<{ readonly accepted: boolean }> => {
    const active = activeCapture?.source;
    if (
      !rendererCaptureAvailable ||
      active?.type !== "renderer-pcm" ||
      active.sessionId !== frame.sessionId ||
      active.generation !== frame.generation ||
      child === null ||
      child.connected === false ||
      typeof child.send !== "function"
    ) {
      return Promise.resolve({ accepted: false });
    }
    const activeChild = child;
    let settle!: (accepted: boolean) => void;
    const sendPromise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const pendingPcmSend: PendingPcmSend = {
      promise: sendPromise,
      settle,
      timer: setTimeout(() => {
        if (!pendingPcmSends.delete(pendingPcmSend)) return;
        settle(false);
      }, PCM_SEND_TIMEOUT_MS),
    };
    pendingPcmSends.add(pendingPcmSend);
    const finishSend = (accepted: boolean): void => {
      if (!pendingPcmSends.delete(pendingPcmSend)) return;
      clearTimeout(pendingPcmSend.timer);
      settle(accepted);
    };
    try {
      activeChild.send?.(
        {
          type: "renderer-pcm",
          sessionId: frame.sessionId,
          generation: frame.generation,
          samples: frame.samples,
        },
        (cause) => {
          finishSend(cause === null);
        },
      );
    } catch {
      finishSend(false);
    }
    return sendPromise.then((accepted) => ({ accepted }));
  };

  const releaseCapture = async (): Promise<{ readonly accepted: boolean }> => {
    if (activeCapture === undefined) return { accepted: false };
    const releaseSession = activeCapture;
    const releaseChild = child;
    let releaseResult: { readonly accepted: boolean } | undefined;
    try {
      await Promise.allSettled([...pendingPcmSends].map((pending) => pending.promise));
      if (releaseChild !== null && child !== releaseChild) return { accepted: false };
      releaseResult = await command("capture-release");
      return releaseResult;
    } finally {
      if (activeCapture === releaseSession && releaseResult?.accepted === false) {
        activeCapture = undefined;
      }
    }
  };

  const cancelCapture = async (): Promise<{ readonly accepted: boolean }> => {
    if (activeCapture === undefined) return { accepted: false };
    const cancelSession = activeCapture;
    const cancelChild = child;
    let cancelResult: { readonly accepted: boolean } | undefined;
    try {
      settlePendingPcmSends(false);
      if (cancelChild !== null && child !== cancelChild) return { accepted: false };
      cancelResult = await command("capture-cancel");
      return cancelResult;
    } finally {
      if (activeCapture === cancelSession && cancelResult?.accepted === false) {
        activeCapture = undefined;
      }
    }
  };

  return {
    getState: () => current,
    prepare: async () => {
      await ensureWorker();
      await send("prepare");
      return current;
    },
    prepareSpeech: () =>
      runLocalSpeechOperation({ accepted: false }, () => command("prepare-speech")),
    playAcknowledgement: () =>
      runLocalSpeechOperation({ accepted: false }, () => command("play-acknowledgement")),
    startCapture: async (input) => {
      // The worker keeps the capture identity until its deferred decode emits
      // capture-result. A release acknowledgement only means the microphone
      // is closed, so do not replace that identity with a new start while the
      // previous transcript is still in flight.
      if (remoteComputeActive || activeCapture !== undefined) {
        return { accepted: false };
      }
      if (localSpeechOperationActive) {
        // Barge-in owns admission here: push-to-talk preempts Jarvis speech
        // instead of surfacing a busy error. The interrupt stops worker TTS;
        // the epoch bump keeps the superseded speak send from reporting a
        // failure toast or fallback speech for speech the user cut off.
        speechEpoch += 1;
        await command("interrupt").catch(() => undefined);
      }
      const started = normalizeDesktopVoiceCaptureStart(input, () => `capture-${++sequence}`);
      const session = {
        purpose: started.purpose,
        captureId: started.captureId,
        source: started.source,
      };
      activeCapture = session;
      const identity = { purpose: started.purpose, captureId: started.captureId };
      const recognitionContext =
        started.contextualPhrases.length === 0
          ? {}
          : { contextualPhrases: started.contextualPhrases };
      if (started.source.type === "renderer-pcm") {
        if (!rendererCaptureAvailable) {
          activeCapture = undefined;
          return { accepted: false };
        }
        const result = await command("capture-start", {
          source: started.source,
          ...identity,
          ...recognitionContext,
        });
        if (!result.accepted && activeCapture === session) activeCapture = undefined;
        return result;
      }
      if (!captureAvailable) {
        activeCapture = undefined;
        return { accepted: false };
      }
      const result = await command("capture-start", { ...identity, ...recognitionContext });
      if (!result.accepted && activeCapture === session) activeCapture = undefined;
      return result;
    },
    pushPcmFrame,
    releaseCapture,
    cancelCapture,
    speak: async (text, lane = "interaction", deliveryId) => {
      if (text.trim().length === 0) return { status: "deferred", reason: "empty" };
      const epoch = speechEpoch;
      const superseded = (): { readonly status: "deferred"; readonly reason: string } | null =>
        epoch === speechEpoch ? null : { status: "deferred", reason: "interrupted" };
      return await runLocalSpeechOperation({ status: "deferred", reason: "busy" }, async () => {
        try {
          await ensureWorker();
          const outcome = await send("speak", {
            text,
            lane,
            ...(deliveryId === undefined ? {} : { deliveryId }),
          });
          const cutOff = superseded();
          if (cutOff !== null) return cutOff;
          if (typeof outcome === "boolean") {
            return outcome ? { status: "played" } : { status: "deferred", reason: "declined" };
          }
          if ("status" in outcome) return outcome;
          throw new Error("Voice worker returned an invalid speech result.");
        } catch (cause) {
          if (superseded() !== null) return { status: "deferred", reason: "interrupted" };
          emit({ type: "error", message: errorMessage(cause) });
          return { status: "failed", code: "voice-worker-unavailable" };
        }
      });
    },
    cancelSpeech: (deliveryId) =>
      remoteComputeActive
        ? Promise.resolve({ accepted: false })
        : command("cancel-speech", { deliveryId }),
    interrupt: () =>
      remoteComputeActive ? Promise.resolve({ accepted: false }) : command("interrupt"),
    transcribeRemote: (input, signal) =>
      runRemoteCompute(async () => {
        const response = await sendRemoteCompute("remote-transcribe", { input }, signal);
        if (response.operation === "transcribe") {
          return response.text;
        }
        throw new Error("Voice worker returned an invalid transcription result.");
      }),
    synthesizeRemote: (text, signal) =>
      runRemoteCompute(async () => {
        const response = await sendRemoteCompute("remote-synthesize", { text }, signal);
        if (response.operation === "synthesize") {
          return response;
        }
        throw new Error("Voice worker returned an invalid synthesis result.");
      }),
    onState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onLevel: (listener) => {
      levelListeners.add(listener);
      return () => levelListeners.delete(listener);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      generation += 1;
      const activeChild = child;
      child = null;
      activeCapture = undefined;
      settlePendingPcmSends(false);
      startup = null;
      for (const request of pending.values()) {
        if (request.timer !== undefined) clearTimeout(request.timer);
        request.reject(new Error("Voice worker stopped."));
      }
      pending.clear();
      if (activeChild !== null && !activeChild.killed) activeChild.kill("SIGTERM");
    },
  };
}

export const layer = Layer.effect(
  DesktopJarvisVoiceService,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<DesktopEnvironment.DesktopEnvironment>();
    const runFork = Effect.runForkWith(context);
    const workerPath = NodePath.join(environment.dirname, "desktopVoiceWorker.cjs");
    const resourceRoot = resolveDesktopJarvisVoiceResourceRoot({
      platform: environment.platform,
      isPackaged: environment.isPackaged,
      resourcesPath: environment.resourcesPath,
      executablePath: environment.executablePath,
      developmentResourceRoot: NodePath.resolve(
        environment.dirname,
        "../../../packages/jarvis-native-voice/resources",
      ),
    });
    return createDesktopJarvisVoice({
      platform: environment.platform,
      workerPath,
      resourceRoot,
      ...(environment.isPackaged
        ? {}
        : { pipecatProjectRoot: NodePath.resolve(environment.dirname, "../pipecat") }),
      executablePath: environment.executablePath,
      emit: (message) => {
        if (message.type === "speech-timing") {
          runFork(logVoiceInfo("Kokoro speech timing", message.timing));
        }
        if (message.type === "voice-timing") {
          runFork(logVoiceInfo("Pipecat voice timing", message.timing));
        }
        broadcastDesktopJarvisVoiceMessage({
          message,
          native: isNativePlatform(environment.platform),
        });
      },
    });
  }),
);
