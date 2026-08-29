// oxlint-disable t3code/no-global-process-runtime -- dedicated native voice child process.
// This entry point is run with the Electron executable in Node mode. It is
// intentionally not an Electron application: the desktop shell remains the
// only process that owns windows, menus, shortcuts, and renderer state.
// @effect-diagnostics nodeBuiltinImport:off globalProcess:off globalTimers:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { DesktopJarvisVoiceSpeechLane } from "@t3tools/contracts";
import * as NodeReadline from "node:readline";

import {
  isVoiceCaptureErrorCode,
  normalizedAudioRms,
  playNativeCue,
  prepareNativeMicrophone,
  startNativePcmCapture,
  createLatestSpeechQueue,
  type LatestSpeechQueue,
  classifyVoiceCaptureError,
  createVoiceCaptureError,
} from "@t3tools/jarvis-native-voice/desktop-native-voice";

import {
  parseDesktopVoiceWorkerCaptureSource,
  parseDesktopVoiceCaptureIdentity,
  canDesktopVoiceWorkerSpeak,
  isDesktopVoiceWorkerRendererPcmCurrent,
  parseDesktopVoiceWorkerRendererPcmMessage,
  normalizeDesktopVoiceContextualPhrases,
  type DesktopVoiceWorkerCommand,
  type DesktopVoiceWorkerMessage,
  type DesktopVoiceWorkerState,
} from "./DesktopVoiceWorkerProtocol.ts";
import {
  createDesktopVoiceCaptureDeadline,
  DESKTOP_VOICE_FIRST_AUDIO_FRAME_DEADLINE_MS,
} from "./DesktopVoiceCaptureDeadline.ts";
import {
  bindDesktopVoiceCaptureResult,
  type DesktopVoiceCaptureSettlement,
} from "./DesktopVoiceCaptureCoordinator.ts";
import {
  createDesktopPipecatSidecar,
  type DesktopPipecatSidecar,
} from "./DesktopPipecatSidecar.ts";

let shuttingDown = false;
const captureAvailable =
  (process.platform === "win32" || process.platform === "linux") && process.arch === "x64";
const write = (message: DesktopVoiceWorkerMessage, allowDuringShutdown = false): void => {
  if (shuttingDown && !allowDuringShutdown) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const resourceRoot = (): string => {
  const configured = process.env.JARVIS_VOICE_ROOT?.trim();
  if (configured) return configured;
  const electronResources = process.resourcesPath;
  if (typeof electronResources === "string") {
    return NodePath.join(electronResources, "jarvis-resources");
  }
  return NodePath.resolve(import.meta.dirname, "../../../packages/jarvis-native-voice/resources");
};

function configureVoiceResources(root: string): void {
  if (process.env.JARVIS_KOKORO_ROOT?.trim()) return;
  process.env.JARVIS_KOKORO_ROOT = NodePath.join(root, "kokoro");
}

function pipecatRuntime(root: string): {
  readonly executablePath: string;
  readonly arguments: ReadonlyArray<string>;
} {
  const configured = process.env.JARVIS_PIPECAT_EXECUTABLE?.trim();
  if (configured) return { executablePath: configured, arguments: [] };
  const packagedExecutable = NodePath.join(
    root,
    "pipecat",
    process.platform === "win32" ? "jarvis-pipecat-voice.exe" : "jarvis-pipecat-voice",
  );
  if (NodeFS.existsSync(packagedExecutable)) {
    return { executablePath: packagedExecutable, arguments: [] };
  }
  const projectRoot = process.env.JARVIS_PIPECAT_PROJECT_ROOT?.trim();
  if (!projectRoot) {
    throw new Error(`The packaged Pipecat voice runtime is missing: ${packagedExecutable}`);
  }
  return {
    executablePath: process.env.JARVIS_PIPECAT_UV?.trim() || "uv",
    arguments: [
      "run",
      "--project",
      projectRoot,
      "python",
      NodePath.join(projectRoot, "scripts", "launch.py"),
    ],
  };
}

let pipecat: DesktopPipecatSidecar | undefined;

function voiceRuntime(root: string): DesktopPipecatSidecar {
  if (pipecat !== undefined) return pipecat;
  const launch = pipecatRuntime(root);
  pipecat = createDesktopPipecatSidecar({
    ...launch,
    modelRoot: NodePath.join(root, "parakeet"),
    kokoroRoot: NodePath.join(root, "kokoro"),
  });
  return pipecat;
}

let speechQueue: LatestSpeechQueue | undefined;
let speechSequence = 0;
let activeSpeechId: string | undefined;

/** Keeps durable speech ordering in Desktop while Pipecat owns synthesis,
 * device playback, interruption, and playout completion. */
function voiceSpeechQueue(root: string): LatestSpeechQueue {
  if (speechQueue !== undefined) return speechQueue;
  speechQueue = createLatestSpeechQueue(
    async (text, signal) => {
      const runtime = voiceRuntime(root);
      if (!(await runtime.prepareSpeech())) {
        throw new Error("Pipecat Kokoro could not be prepared.");
      }
      if (signal.aborted) return;
      const speechId = `worker-speech-${++speechSequence}`;
      activeSpeechId = speechId;
      const abort = (): void => {
        void runtime.cancelSpeech(speechId);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await runtime.speak({ speechId, text });
        if (result.timing !== undefined) {
          write({ type: "speech-timing", timing: result.timing });
        }
        if (result.status === "failure") {
          throw new Error(result.message ?? "Pipecat speech failed.");
        }
      } finally {
        signal.removeEventListener("abort", abort);
        if (activeSpeechId === speechId) activeSpeechId = undefined;
      }
    },
    () => {
      // A failed rewarm is recoverable: the next PTT start retries Parakeet
      // activation without turning a successfully played utterance into an
      // unhandled worker failure.
      void voiceRuntime(root)
        .prepareListening()
        .catch(() => undefined);
    },
  );
  return speechQueue;
}

function speakQueued(
  root: string,
  text: string,
  lane: DesktopJarvisVoiceSpeechLane = "interaction",
): Promise<boolean> {
  const queue = voiceSpeechQueue(root);
  if (lane === "completion-report") return queue.enqueue(text);
  return queue.reserve().commit(text);
}

function interruptPipecatSpeech(root: string): void {
  speechQueue?.interrupt();
  if (activeSpeechId !== undefined) {
    void voiceRuntime(root).cancelSpeech(activeSpeechId);
  }
}

type WorkerCapture = {
  readonly result: Promise<string>;
  release(): void;
  cancel(): void;
};
type PendingCaptureAction = "release" | "cancel";

const MAX_PENDING_NATIVE_PCM_BYTES = 1_048_576;
let capture: WorkerCapture | null = null;
let pendingCaptureStart: { readonly captureId: string; action?: PendingCaptureAction } | null =
  null;
let rendererCaptureActive = false;
let rendererCaptureSessionId: string | undefined;
let rendererCaptureGeneration: number | undefined;
let rendererRuntimeCaptureId: string | undefined;
let rendererSampleRate: number | undefined;
let rendererChannels: number | undefined;
let lastRendererAudioLevelAt = Number.NEGATIVE_INFINITY;
let captureGeneration = 0;
let captureReleased = false;
let captureFailureMessage: string | undefined;
let captureFailureCode:
  | import("@t3tools/jarvis-native-voice/desktop-native-voice").VoiceCaptureErrorCode
  | undefined;
const captureDeadline = createDesktopVoiceCaptureDeadline();
const firstAudioFrameDeadline = createDesktopVoiceCaptureDeadline({
  delayMs: DESKTOP_VOICE_FIRST_AUDIO_FRAME_DEADLINE_MS,
});

const clearCaptureDeadlines = (): void => {
  captureDeadline.clear();
  firstAudioFrameDeadline.clear();
};

const captureTimeoutMessage = "Voice capture timed out. Try again.";
const captureNoAudioMessage =
  "No audio was received from the microphone. Check microphone permissions and that an input device is connected.";

let shutdownPromise: Promise<void> | undefined;
const shutdownRuntime = async (root: string): Promise<void> => {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shutdownPromise = (async () => {
    // Invalidate capture callbacks before disposing the sidecar. This also
    // makes stdin close and SIGTERM safe while a decode is still unwinding.
    shuttingDown = true;
    captureGeneration += 1;
    clearCaptureDeadlines();
    captureFailureMessage = undefined;
    captureFailureCode = undefined;
    capture?.cancel();
    capture = null;
    rendererCaptureActive = false;
    rendererCaptureSessionId = undefined;
    rendererCaptureGeneration = undefined;
    rendererRuntimeCaptureId = undefined;
    rendererSampleRate = undefined;
    rendererChannels = undefined;
    captureReleased = false;
    interruptPipecatSpeech(root);
    await pipecat?.shutdown();
  })();
  return shutdownPromise;
};

const setState = (next: DesktopVoiceWorkerState): void => {
  write({ type: "state", state: next });
};

const result = (
  requestId: string,
  cause?: unknown,
  allowDuringShutdown = false,
  accepted = true,
): void => {
  if (shuttingDown && !allowDuringShutdown) return;
  if (cause === undefined) {
    write(
      {
        type: "result",
        requestId,
        ok: true,
        ...(accepted ? {} : { accepted: false }),
      },
      allowDuringShutdown,
    );
    return;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = classifyVoiceCaptureError(cause);
  write({ type: "result", requestId, ok: false, message, code }, allowDuringShutdown);
};

const handle = async (command: DesktopVoiceWorkerCommand): Promise<boolean> => {
  if (shuttingDown && command.type !== "shutdown") return false;
  const root = resourceRoot();
  configureVoiceResources(root);
  const runtime = voiceRuntime(root);
  try {
    switch (command.type) {
      case "prepare":
        if (captureAvailable) prepareNativeMicrophone();
        // Pipecat owns both model lifecycles. Prepare only starts the resident
        // sidecar; model loading remains explicit at speech/capture boundaries.
        await runtime.ensureReady();
        if (capture === null) setState("ready");
        result(command.requestId);
        return false;
      case "prepare-speech":
        if (!(await runtime.prepareSpeech())) {
          throw new Error("Pipecat Kokoro could not be prepared.");
        }
        result(command.requestId);
        return false;
      case "play-acknowledgement": {
        const speechGeneration = captureGeneration;
        if (
          !canDesktopVoiceWorkerSpeak({
            captureActive: capture !== null,
            captureStarting: pendingCaptureStart !== null,
            captureGeneration,
            speechGeneration,
          })
        ) {
          result(command.requestId, new Error("Audio feedback is unavailable while capturing."));
          return false;
        }
        setState("speaking");
        try {
          await voiceSpeechQueue(root).performOrdered((signal) =>
            playNativeCue(NodePath.join(root, "listening.wav"), process.platform, signal),
          );
        } catch (cause) {
          if (
            canDesktopVoiceWorkerSpeak({
              captureActive: capture !== null,
              captureStarting: pendingCaptureStart !== null,
              captureGeneration,
              speechGeneration,
            })
          ) {
            setState("error");
          }
          result(command.requestId, cause);
          return false;
        }
        if (
          !voiceSpeechQueue(root).isActive() &&
          canDesktopVoiceWorkerSpeak({
            captureActive: capture !== null,
            captureStarting: pendingCaptureStart !== null,
            captureGeneration,
            speechGeneration,
          })
        ) {
          setState("ready");
        }
        result(command.requestId);
        return false;
      }
      case "capture-start":
        if (command.source?.type === "renderer-pcm" && process.platform !== "darwin") {
          result(command.requestId, new Error("Renderer PCM capture is only available on macOS."));
          return false;
        }
        if (command.source?.type !== "renderer-pcm" && !captureAvailable) {
          result(
            command.requestId,
            new Error("Microphone capture is unavailable on this platform."),
          );
          return false;
        }
        if (capture !== null || pendingCaptureStart !== null) {
          result(command.requestId, new Error("Voice capture is already active."));
          return false;
        }
        captureGeneration += 1;
        // Push-to-talk is a barge-in action: stop Jarvis speaking before the
        // microphone opens, otherwise the recognizer can capture its own TTS.
        interruptPipecatSpeech(root);
        setState("starting");
        const rendererSource = command.source?.type === "renderer-pcm" ? command.source : undefined;
        const runtimeCaptureId = command.captureId ?? `worker-capture-${captureGeneration}`;
        captureReleased = false;
        captureFailureMessage = undefined;
        captureFailureCode = undefined;
        let inputCapture: ReturnType<typeof startNativePcmCapture> | undefined;
        let inputSampleRate = rendererSource?.sampleRate;
        let inputChannels = rendererSource?.channels;
        let firstAudioReceived = false;
        const pendingNativeFrames: Array<{
          readonly samples: Float32Array;
          readonly sampleRate: number;
          readonly channels: number;
        }> = [];
        let pendingNativePcmBytes = 0;
        let runtimeCaptureStarted = false;
        let runtimeTransportFailed = false;
        let rejectTransport!: (cause: Error) => void;
        const transportFailure = new Promise<never>((_, reject) => {
          rejectTransport = reject;
        });
        const sendPcm = (frame: {
          readonly samples: Float32Array;
          readonly sampleRate: number;
          readonly channels: number;
        }): void => {
          if (runtimeTransportFailed || shuttingDown || captureReleased) return;
          if (!runtimeCaptureStarted) {
            const frameBytes = frame.samples.byteLength;
            if (pendingNativePcmBytes + frameBytes > MAX_PENDING_NATIVE_PCM_BYTES) {
              runtimeTransportFailed = true;
              captureFailureMessage = "Pipecat could not keep up while starting voice capture.";
              captureFailureCode = "transcription-failed";
              captureReleased = true;
              inputCapture?.cancel();
              rejectTransport(new Error(captureFailureMessage));
              return;
            }
            pendingNativeFrames.push({ ...frame, samples: frame.samples.slice() });
            pendingNativePcmBytes += frameBytes;
            return;
          }
          void runtime
            .pushPcm({ captureId: runtimeCaptureId, ...frame })
            .then((accepted) => {
              if (accepted || runtimeTransportFailed) return;
              runtimeTransportFailed = true;
              rejectTransport(new Error("Pipecat stopped accepting microphone audio."));
            })
            .catch((cause: unknown) => {
              if (runtimeTransportFailed) return;
              runtimeTransportFailed = true;
              rejectTransport(cause instanceof Error ? cause : new Error(String(cause)));
            });
        };
        if (rendererSource === undefined) {
          inputCapture = startNativePcmCapture({
            onFirstAudioFrame: () => {
              firstAudioReceived = true;
              firstAudioFrameDeadline.clear();
            },
            onAudioLevel: (level) => write({ type: "level", level }),
            onAudioFrame: sendPcm,
          });
          inputSampleRate = inputCapture.sampleRate;
          inputChannels = inputCapture.channels;
          rendererCaptureActive = false;
          rendererCaptureSessionId = undefined;
          rendererCaptureGeneration = undefined;
          rendererRuntimeCaptureId = undefined;
          rendererSampleRate = undefined;
          rendererChannels = undefined;
        } else {
          rendererCaptureActive = true;
          rendererCaptureSessionId = rendererSource.sessionId;
          rendererCaptureGeneration = rendererSource.generation;
          rendererRuntimeCaptureId = runtimeCaptureId;
          rendererSampleRate = rendererSource.sampleRate;
          rendererChannels = rendererSource.channels;
        }
        if (inputSampleRate === undefined || inputChannels === undefined) {
          inputCapture?.cancel();
          throw new Error("Microphone capture did not report its audio format.");
        }
        // The microphone is already open and bounded buffering is active. Do
        // not call a legitimate Parakeet model swap "warming the microphone".
        setState("capturing");
        const pendingStart: { readonly captureId: string; action?: PendingCaptureAction } = {
          captureId: runtimeCaptureId,
        };
        pendingCaptureStart = pendingStart;
        const sidecarStart = runtime.startCapture({
          captureId: runtimeCaptureId,
          sampleRate: inputSampleRate,
          channels: inputChannels,
          contextualPhrases: command.contextualPhrases ?? [],
          onTranscript: (text) =>
            write({
              type: "transcript",
              text,
              ...(command.purpose === undefined ? {} : { purpose: command.purpose }),
              ...(command.captureId === undefined ? {} : { captureId: command.captureId }),
            }),
          onTiming: (timing) => write({ type: "voice-timing", timing }),
        });
        let sidecarCapture: Awaited<ReturnType<DesktopPipecatSidecar["startCapture"]>>;
        try {
          sidecarCapture = await Promise.race([sidecarStart, transportFailure]);
        } catch (cause) {
          if (runtimeTransportFailed) {
            await runtime.cancelCapture(runtimeCaptureId);
            await sidecarStart.catch(() => undefined);
          }
          if (pendingCaptureStart === pendingStart) pendingCaptureStart = null;
          inputCapture?.cancel();
          rendererCaptureActive = false;
          rendererCaptureSessionId = undefined;
          rendererCaptureGeneration = undefined;
          rendererRuntimeCaptureId = undefined;
          rendererSampleRate = undefined;
          rendererChannels = undefined;
          throw cause;
        }
        if (pendingCaptureStart === pendingStart) pendingCaptureStart = null;
        runtimeCaptureStarted = true;
        pendingNativePcmBytes = 0;
        for (const frame of pendingNativeFrames.splice(0)) sendPcm(frame);
        const runtimeResult = Promise.race([sidecarCapture.result, transportFailure]).then(
          (settlement) => {
            if (settlement.ok) return settlement.text;
            throw createVoiceCaptureError(
              isVoiceCaptureErrorCode(settlement.code) ? settlement.code : "transcription-failed",
              settlement.message,
            );
          },
        );
        capture = {
          result: runtimeResult,
          release: () => {
            inputCapture?.release();
            void runtime.releaseCapture(runtimeCaptureId).then((accepted) => {
              if (!accepted && !runtimeTransportFailed) {
                runtimeTransportFailed = true;
                rejectTransport(new Error("Pipecat could not finalize voice capture."));
              }
            });
          },
          cancel: () => {
            inputCapture?.cancel();
            void runtime.cancelCapture(runtimeCaptureId).then((accepted) => {
              if (!accepted && !runtimeTransportFailed) {
                runtimeTransportFailed = true;
                rejectTransport(new Error("Pipecat could not cancel voice capture."));
              }
            });
          },
        };
        const pendingAction = pendingStart.action;
        if (pendingAction !== undefined) {
          captureReleased = true;
          setState("transcribing");
          if (pendingAction === "release") capture.release();
          else capture.cancel();
        }
        if (pendingAction === undefined && !firstAudioReceived) {
          firstAudioFrameDeadline.arm(() => {
            if (shuttingDown || capture === null || captureReleased) return;
            captureFailureMessage = captureNoAudioMessage;
            captureFailureCode = "no-audio-frames";
            captureReleased = true;
            setState("transcribing");
            capture.cancel();
          });
        }
        if (pendingAction === undefined) {
          write({
            type: "capture-ready",
            ...(rendererSource === undefined
              ? {}
              : { sessionId: rendererSource.sessionId, generation: rendererSource.generation }),
            ...(command.purpose === undefined ? {} : { purpose: command.purpose }),
            ...(command.captureId === undefined ? {} : { captureId: command.captureId }),
          });
          captureDeadline.arm(() => {
            if (capture === null || captureReleased) return;
            captureFailureMessage = captureTimeoutMessage;
            captureFailureCode = "capture-timeout";
            captureReleased = true;
            setState("transcribing");
            capture.release();
          });
        }
        const activeCapture = capture;
        bindDesktopVoiceCaptureResult({
          capture: activeCapture,
          result: activeCapture.result,
          isActive: (candidate) => capture === candidate,
          onSettled: (settlement: DesktopVoiceCaptureSettlement) => {
            clearCaptureDeadlines();
            if (settlement.ok) {
              write({
                type: "capture-result",
                ok: true,
                text: settlement.text,
                ...(command.purpose === undefined ? {} : { purpose: command.purpose }),
                ...(command.captureId === undefined ? {} : { captureId: command.captureId }),
              });
            } else {
              write({
                type: "capture-result",
                ok: false,
                message: captureFailureMessage ?? settlement.message,
                code:
                  captureFailureCode ??
                  settlement.code ??
                  classifyVoiceCaptureError(settlement.message),
                ...(command.purpose === undefined ? {} : { purpose: command.purpose }),
                ...(command.captureId === undefined ? {} : { captureId: command.captureId }),
              });
            }
            capture = null;
            rendererCaptureActive = false;
            rendererCaptureSessionId = undefined;
            rendererCaptureGeneration = undefined;
            captureReleased = false;
            captureFailureMessage = undefined;
            captureFailureCode = undefined;
            captureGeneration += 1;
            setState("ready");
          },
        });
        result(command.requestId);
        return false;
      case "capture-release":
        clearCaptureDeadlines();
        if (capture !== null && !captureReleased) {
          setState("transcribing");
          captureReleased = true;
          capture.release();
        } else if (capture === null && pendingCaptureStart !== null) {
          pendingCaptureStart.action ??= "release";
        } else if (capture === null) setState("ready");
        result(command.requestId);
        return false;
      case "capture-cancel":
        clearCaptureDeadlines();
        if (capture !== null) {
          captureFailureMessage = "Voice capture was cancelled.";
          captureFailureCode = "cancelled";
          captureReleased = true;
          capture.cancel();
          setState("transcribing");
        } else if (pendingCaptureStart !== null) {
          pendingCaptureStart.action ??= "cancel";
        } else setState("ready");
        result(command.requestId);
        return false;
      case "speak": {
        const speechGeneration = captureGeneration;
        if (
          !canDesktopVoiceWorkerSpeak({
            captureActive: capture !== null,
            captureStarting: pendingCaptureStart !== null,
            captureGeneration,
            speechGeneration,
          })
        ) {
          result(command.requestId, new Error("Voice playback is unavailable while capturing."));
          return false;
        }
        setState("speaking");
        try {
          const spoken = await speakQueued(root, command.text, command.lane);
          if (!spoken) {
            if (
              !voiceSpeechQueue(root).isActive() &&
              canDesktopVoiceWorkerSpeak({
                captureActive: capture !== null,
                captureStarting: pendingCaptureStart !== null,
                captureGeneration,
                speechGeneration,
              })
            ) {
              setState("ready");
            }
            result(command.requestId, undefined, false, false);
            return false;
          }
        } catch (cause) {
          // A capture can begin while speech is unwinding. In that case the
          // failed speech command still reports its own failure, but must not
          // overwrite the newer capture's state with a global error.
          if (
            canDesktopVoiceWorkerSpeak({
              captureActive: capture !== null,
              captureStarting: pendingCaptureStart !== null,
              captureGeneration,
              speechGeneration,
            })
          ) {
            setState("error");
          }
          result(command.requestId, cause);
          return false;
        }
        if (
          !voiceSpeechQueue(root).isActive() &&
          canDesktopVoiceWorkerSpeak({
            captureActive: capture !== null,
            captureStarting: pendingCaptureStart !== null,
            captureGeneration,
            speechGeneration,
          })
        ) {
          setState("ready");
        }
        result(command.requestId);
        return false;
      }
      case "interrupt":
        clearCaptureDeadlines();
        captureFailureMessage = capture === null ? undefined : "Voice capture was cancelled.";
        captureFailureCode = capture === null ? undefined : "cancelled";
        interruptPipecatSpeech(root);
        if (capture !== null) {
          captureReleased = true;
          capture.cancel();
        }
        if (capture === null) setState("ready");
        result(command.requestId);
        return false;
      case "shutdown":
        await shutdownRuntime(root);
        result(command.requestId, undefined, true);
        return true;
    }
  } catch (cause) {
    setState("error");
    result(command.requestId, cause);
    return false;
  }
};

const parseCommand = (line: string): DesktopVoiceWorkerCommand | null => {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("type" in value)) return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.requestId !== "string") return null;
    const source = parseDesktopVoiceWorkerCaptureSource(candidate.source);
    const contextualPhrases = normalizeDesktopVoiceContextualPhrases(candidate.contextualPhrases);
    if (
      candidate.contextualPhrases !== undefined &&
      (!Array.isArray(candidate.contextualPhrases) ||
        candidate.contextualPhrases.length > 64 ||
        !candidate.contextualPhrases.every(
          (phrase) =>
            typeof phrase === "string" && phrase.trim().length > 0 && phrase.trim().length <= 100,
        ))
    ) {
      return null;
    }
    if (candidate.source !== undefined && source === undefined) return null;
    if (
      candidate.type === "prepare" ||
      candidate.type === "prepare-speech" ||
      candidate.type === "play-acknowledgement" ||
      candidate.type === "capture-start" ||
      candidate.type === "capture-release" ||
      candidate.type === "capture-cancel" ||
      candidate.type === "interrupt" ||
      candidate.type === "shutdown"
    ) {
      return {
        type: candidate.type,
        requestId: candidate.requestId,
        ...(candidate.type === "capture-start" && source !== undefined ? { source } : {}),
        ...(candidate.type === "capture-start" ? parseDesktopVoiceCaptureIdentity(candidate) : {}),
        ...(candidate.type === "capture-start" && contextualPhrases.length > 0
          ? { contextualPhrases }
          : {}),
      } as DesktopVoiceWorkerCommand;
    }
    if (candidate.type === "speak" && typeof candidate.text === "string") {
      if (
        candidate.lane !== undefined &&
        candidate.lane !== "interaction" &&
        candidate.lane !== "completion-report"
      ) {
        return null;
      }
      return {
        type: "speak",
        requestId: candidate.requestId,
        text: candidate.text,
        ...(candidate.lane === undefined ? {} : { lane: candidate.lane }),
      };
    }
  } catch {
    // Malformed input is ignored; a broken renderer must not take down the
    // desktop process or turn the worker into an arbitrary command shell.
  }
  return null;
};

setState("starting");
void (async () => {
  try {
    if (captureAvailable) prepareNativeMicrophone();
    await voiceRuntime(resourceRoot()).ensureReady();
    setState("ready");
    write({ type: "ready" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    write({ type: "fatal", message, code: "VOICE_UNAVAILABLE" });
    process.exitCode = 1;
  }
})();

const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = parseCommand(line);
  if (command === null) return;
  void handle(command).then((shouldExit) => {
    if (shouldExit) {
      lines.close();
      if (process.connected) process.disconnect();
      process.exitCode = 0;
    }
  });
});

const closeWorker = (): void => {
  void shutdownRuntime(resourceRoot()).finally(() => {
    if (process.connected) process.disconnect();
    process.exit(0);
  });
};
lines.once("close", closeWorker);
process.once("SIGTERM", closeWorker);
process.once("SIGINT", closeWorker);

process.on("message", (value: unknown) => {
  const message = parseDesktopVoiceWorkerRendererPcmMessage(value);
  if (
    message === null ||
    shuttingDown ||
    captureReleased ||
    !rendererCaptureActive ||
    rendererRuntimeCaptureId === undefined ||
    rendererSampleRate === undefined ||
    rendererChannels === undefined ||
    !isDesktopVoiceWorkerRendererPcmCurrent(
      message,
      rendererCaptureSessionId,
      rendererCaptureGeneration,
    )
  ) {
    return;
  }
  firstAudioFrameDeadline.clear();
  const now = performance.now();
  if (now - lastRendererAudioLevelAt >= 90) {
    lastRendererAudioLevelAt = now;
    write({ type: "level", level: normalizedAudioRms(message.samples) });
  }
  void voiceRuntime(resourceRoot())
    .pushPcm({
      captureId: rendererRuntimeCaptureId,
      sampleRate: rendererSampleRate,
      channels: rendererChannels,
      samples: message.samples,
    })
    .then((accepted) => {
      if (accepted || capture === null || captureReleased) return;
      captureFailureMessage = "Pipecat stopped accepting microphone audio.";
      captureFailureCode = "transcription-failed";
      captureReleased = true;
      setState("transcribing");
      capture.cancel();
    });
});
