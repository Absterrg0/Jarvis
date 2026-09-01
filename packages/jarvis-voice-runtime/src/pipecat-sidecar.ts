// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";

import {
  DESKTOP_PIPECAT_MAX_SYNTHESIS_TEXT_LENGTH,
  DESKTOP_PIPECAT_MAX_LINE_BYTES,
  DESKTOP_PIPECAT_PROTOCOL_VERSION,
  encodeDesktopPipecatCommand,
  floatPcmToInt16Chunks,
  parseDesktopPipecatMessage,
  type DesktopPipecatCommand,
  type DesktopPipecatMessage,
  type DesktopPipecatSpeechTiming,
  type DesktopPipecatTiming,
} from "./pipecat-protocol.ts";

type PipecatChild = {
  readonly stdin: {
    readonly destroyed?: boolean;
    write: (line: string, callback?: (cause?: Error | null) => void) => boolean;
    once: (event: "drain", listener: () => void) => void;
  } | null;
  readonly stdout: NodeEvents.EventEmitter | null;
  readonly stderr: NodeEvents.EventEmitter | null;
  readonly killed: boolean;
  readonly kill: (signal?: NodeJS.Signals) => boolean;
  once: (event: "error" | "exit", listener: (...args: Array<unknown>) => void) => void;
};

type CaptureResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string; readonly code?: string };

type CaptureState = {
  readonly result: Promise<CaptureResult>;
  readonly resolve: (value: CaptureResult) => void;
  readonly reject: (cause: Error) => void;
  readonly onTranscript?: (text: string) => void;
  readonly onTiming?: (timing: DesktopPipecatTiming) => void;
  nextPcmSequence: number;
  pcmTail: Promise<boolean>;
  queuedPcmBytes: number;
  pcmFailed: boolean;
};

type PendingCaptureStart = {
  readonly captureId: string;
  action?: "release" | "cancel";
  actionResult?: Promise<boolean>;
  resolveAction?: (accepted: boolean) => void;
};

type PendingRequest = {
  readonly resolve: () => void;
  readonly reject: (cause: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type DesktopPipecatSpeechResult =
  | { readonly status: "completed"; readonly timing?: DesktopPipecatSpeechTiming }
  | {
      readonly status: "interrupted" | "failure";
      readonly message?: string;
      readonly code?: string;
      readonly timing?: DesktopPipecatSpeechTiming;
    };

type SpeechState = {
  readonly speechId: string;
  readonly result: Promise<DesktopPipecatSpeechResult>;
  readonly resolve: (value: DesktopPipecatSpeechResult) => void;
  readonly reject: (cause: Error) => void;
  cancelRequested: boolean;
  receivedResult?: DesktopPipecatSpeechResult;
};

export type PipecatSynthesisResult = {
  readonly sampleRate: number;
  readonly channels: 1;
  readonly pcm: Buffer;
};

type SynthesisState = {
  readonly result: Promise<PipecatSynthesisResult>;
  readonly resolve: (value: PipecatSynthesisResult) => void;
  readonly reject: (cause: Error) => void;
  readonly chunks: Buffer[];
  nextSequence: number;
  sampleRate?: number;
  audioBytes: number;
};

type DesktopPipecatCommandInput = DesktopPipecatCommand extends infer Command
  ? Command extends { readonly requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

export type DesktopPipecatSidecar = {
  readonly ensureReady: () => Promise<void>;
  readonly startCapture: (input: {
    readonly captureId: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly contextualPhrases: ReadonlyArray<string>;
    readonly onTranscript?: (text: string) => void;
    readonly onTiming?: (timing: DesktopPipecatTiming) => void;
  }) => Promise<{ readonly result: Promise<CaptureResult> }>;
  readonly pushPcm: (input: {
    readonly captureId: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly samples: Float32Array;
  }) => Promise<boolean>;
  readonly releaseCapture: (captureId: string) => Promise<boolean>;
  readonly cancelCapture: (captureId: string) => Promise<boolean>;
  readonly prepareSpeech: () => Promise<boolean>;
  readonly prepareListening: () => Promise<boolean>;
  readonly speak: (input: {
    readonly speechId: string;
    readonly text: string;
  }) => Promise<DesktopPipecatSpeechResult>;
  readonly cancelSpeech: (speechId: string) => Promise<boolean>;
  readonly transcribe: (input: {
    readonly audio: Uint8Array;
    readonly sampleRate: number;
    readonly channels: number;
    readonly contextualPhrases?: ReadonlyArray<string>;
  }) => Promise<string>;
  readonly synthesize: (text: string) => Promise<PipecatSynthesisResult>;
  readonly cancel: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 2_000;
const MAX_QUEUED_PCM_BYTES = 1_048_576;
const MAX_TRANSCRIPTION_DURATION_SECONDS = 15;

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Supervises one resident Pipecat process and correlates every response. */
export function createDesktopPipecatSidecar(input: {
  readonly executablePath: string;
  readonly arguments?: ReadonlyArray<string>;
  readonly modelRoot: string;
  readonly kokoroRoot?: string;
  readonly spawn?: typeof NodeChildProcess.spawn;
  readonly startupTimeoutMs?: number;
  readonly backpressureTimeoutMs?: number;
  /** Model swaps can exceed the normal command/PCM acknowledgement budget. */
  readonly modelTransitionTimeoutMs?: number;
}): DesktopPipecatSidecar {
  const spawn = input.spawn ?? NodeChildProcess.spawn;
  const startupTimeoutMs = input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const backpressureTimeoutMs = input.backpressureTimeoutMs ?? DEFAULT_BACKPRESSURE_TIMEOUT_MS;
  const modelTransitionTimeoutMs = input.modelTransitionTimeoutMs ?? 30_000;
  let child: PipecatChild | null = null;
  let startup: Promise<void> | null = null;
  let sequence = 0;
  let output = "";
  let stopped = false;
  let protocolFailure: Error | null = null;
  const pending = new Map<string, PendingRequest>();
  const captures = new Map<string, CaptureState>();
  const speeches = new Map<string, SpeechState>();
  const syntheses = new Map<string, SynthesisState>();
  const startingCaptures = new Map<string, PendingCaptureStart>();
  let stderrTail = "";

  const rejectAll = (cause: unknown): void => {
    const error = asError(cause);
    for (const request of pending.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    for (const capture of captures.values()) {
      capture.result.catch(() => undefined);
      capture.reject(error);
    }
    captures.clear();
    for (const speech of speeches.values()) {
      speech.result.catch(() => undefined);
      speech.reject(error);
    }
    speeches.clear();
    for (const synthesis of syntheses.values()) {
      synthesis.result.catch(() => undefined);
      synthesis.reject(error);
    }
    syntheses.clear();
    for (const start of startingCaptures.values()) start.resolveAction?.(false);
    startingCaptures.clear();
    child = null;
    startup = null;
  };

  const handleMessage = (message: DesktopPipecatMessage): void => {
    if (message.type === "result") {
      const request = pending.get(message.requestId);
      if (request === undefined) return;
      pending.delete(message.requestId);
      if (request.timer !== undefined) clearTimeout(request.timer);
      if (message.ok) request.resolve();
      else request.reject(new Error(message.message));
      return;
    }
    if (message.type === "transcript") {
      captures.get(message.captureId)?.onTranscript?.(message.text);
      return;
    }
    if (message.type === "stt-timing") {
      captures.get(message.timing.captureId)?.onTiming?.(message.timing);
      return;
    }
    if (message.type === "speech-result") {
      const speech = speeches.get(message.speechId);
      if (speech === undefined) return;
      speech.receivedResult = {
        status: message.status,
        ...(message.message === undefined ? {} : { message: message.message }),
        ...(message.code === undefined ? {} : { code: message.code }),
        ...(message.timing === undefined ? {} : { timing: message.timing }),
      } as DesktopPipecatSpeechResult;
      settleSpeech(speech);
      return;
    }
    if (message.type === "synthesis-audio") {
      const synthesis = syntheses.get(message.synthesisId);
      if (synthesis === undefined) return;
      if (message.sequence !== synthesis.nextSequence) {
        synthesis.reject(new Error("Pipecat synthesis audio sequence is stale or out of order."));
        syntheses.delete(message.synthesisId);
        return;
      }
      try {
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(message.data)
        ) {
          throw new Error("Pipecat synthesis audio is not valid base64.");
        }
        const chunk = Buffer.from(message.data, "base64");
        if (chunk.length === 0 || chunk.length % 2 !== 0) {
          throw new Error("Pipecat synthesis audio is not signed 16-bit PCM.");
        }
        if (synthesis.sampleRate !== undefined && synthesis.sampleRate !== message.sampleRate) {
          throw new Error("Pipecat synthesis sample rate changed between chunks.");
        }
        if (synthesis.audioBytes + chunk.length > 8_000_000) {
          throw new Error("Pipecat synthesis audio exceeded its limit.");
        }
        synthesis.sampleRate = message.sampleRate;
        synthesis.audioBytes += chunk.length;
        synthesis.chunks.push(chunk);
        synthesis.nextSequence += 1;
      } catch (cause) {
        synthesis.reject(asError(cause));
        syntheses.delete(message.synthesisId);
      }
      return;
    }
    if (message.type === "synthesis-result") {
      const synthesis = syntheses.get(message.synthesisId);
      if (synthesis === undefined) return;
      syntheses.delete(message.synthesisId);
      if (!message.ok) {
        synthesis.reject(new Error(message.message));
        return;
      }
      const pcm = Buffer.concat(synthesis.chunks);
      if (
        pcm.length !== message.audioBytes ||
        pcm.length % 2 !== 0 ||
        synthesis.sampleRate !== message.sampleRate
      ) {
        synthesis.reject(new Error("Pipecat synthesis audio length was invalid."));
        return;
      }
      synthesis.resolve({
        sampleRate: message.sampleRate,
        channels: 1,
        pcm,
      });
      return;
    }
    if (message.type !== "capture-result") return;
    const capture = captures.get(message.captureId);
    // A cancelled/replaced capture is intentionally invisible to the caller.
    if (capture === undefined) return;
    captures.delete(message.captureId);
    if (message.ok) capture.resolve({ ok: true, text: message.text });
    else {
      capture.resolve({
        ok: false,
        message: message.message,
        ...(message.code === undefined ? {} : { code: message.code }),
      });
    }
  };

  function settleSpeech(speech: SpeechState): void {
    const result = speech.receivedResult;
    if (result === undefined) return;
    speeches.delete(speech.speechId);
    speech.resolve(result);
  }

  const failProtocol = (
    activeChild: PipecatChild,
    finishStartup: (cause?: Error) => void,
    error: Error,
  ): void => {
    protocolFailure = error;
    rejectAll(error);
    finishStartup(error);
    if (!activeChild.killed) activeChild.kill("SIGTERM");
  };

  const attach = (activeChild: PipecatChild, finishStartup: (cause?: Error) => void): void => {
    const stdout = activeChild.stdout;
    stdout?.on("data", (chunk: Buffer | string) => {
      if (child !== activeChild || stopped) return;
      output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = output.split(/\r?\n/u);
      output = lines.pop() ?? "";
      if (Buffer.byteLength(output, "utf8") > DESKTOP_PIPECAT_MAX_LINE_BYTES) {
        failProtocol(
          activeChild,
          finishStartup,
          new Error("Pipecat sidecar emitted an oversized record."),
        );
        return;
      }
      for (const line of lines) {
        if (line.length === 0) continue;
        if (Buffer.byteLength(line, "utf8") > DESKTOP_PIPECAT_MAX_LINE_BYTES) {
          failProtocol(
            activeChild,
            finishStartup,
            new Error("Pipecat sidecar emitted an oversized record."),
          );
          return;
        }
        try {
          const message = parseDesktopPipecatMessage(JSON.parse(line));
          if (message === null) {
            failProtocol(
              activeChild,
              finishStartup,
              new Error("Pipecat sidecar emitted an invalid protocol record."),
            );
            return;
          }
          handleMessage(message);
          if (message.type === "ready") finishStartup();
          if (message.type === "fatal") {
            const error = new Error(message.message);
            rejectAll(error);
            if (!activeChild.killed) activeChild.kill("SIGTERM");
            finishStartup(error);
          }
        } catch {
          failProtocol(
            activeChild,
            finishStartup,
            new Error("Pipecat sidecar emitted malformed JSON."),
          );
          return;
        }
      }
    });
    activeChild.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrTail = `${stderrTail}${text}`.slice(-8_192);
    });
    activeChild.once("error", (cause) => {
      const error = asError(cause);
      if (child !== activeChild) {
        finishStartup(error);
        return;
      }
      rejectAll(error);
      finishStartup(error);
    });
    activeChild.once("exit", (code) => {
      const diagnostic = stderrTail.trim();
      const error = new Error(
        `Pipecat sidecar exited (${String(code ?? "unknown")}).${diagnostic.length === 0 ? "" : ` ${diagnostic}`}`,
      );
      if (child !== activeChild) {
        finishStartup(error);
        return;
      }
      rejectAll(error);
      finishStartup(error);
    });
  };

  const write = (command: DesktopPipecatCommand): Promise<void> => {
    const activeChild = child;
    const stdin = activeChild?.stdin;
    if (activeChild === null || stdin === null || stdin === undefined || stdin.destroyed) {
      return Promise.reject(new Error("Pipecat sidecar is not running."));
    }
    const line = encodeDesktopPipecatCommand(command);
    const requestId = command.requestId;
    return new Promise<void>((resolve, reject) => {
      const request: PendingRequest = { resolve, reject };
      pending.set(requestId, request);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (cause?: Error): void => {
        if (pending.get(requestId) !== request) return;
        pending.delete(requestId);
        if (timer !== undefined) clearTimeout(timer);
        if (cause === undefined) resolve();
        else reject(cause);
      };
      timer = setTimeout(
        () => {
          const error = new Error("Pipecat sidecar command timed out.");
          settle(error);
          // A missing acknowledgement leaves the resident process state
          // unknowable. Discard every correlated operation and replace the
          // process before accepting another command, regardless of which
          // command timed out.
          const timedOutChild = activeChild;
          rejectAll(error);
          if (!timedOutChild.killed) {
            timedOutChild.kill("SIGTERM");
          }
        },
        command.type === "capture-start" ||
          command.type === "speech-prepare" ||
          command.type === "listening-prepare" ||
          command.type === "synthesis-start"
          ? modelTransitionTimeoutMs
          : backpressureTimeoutMs,
      );
      request.timer = timer;
      try {
        const accepted = stdin.write(line, (cause) => {
          if (cause !== undefined && cause !== null) settle(cause);
        });
        // `write` returning true only means Node accepted the bytes. The
        // request remains pending until the sidecar correlates its result.
        // When the stream is full, the drain event is useful as a health
        // signal, but it is not the command acknowledgement either.
        if (!accepted) stdin.once("drain", () => undefined);
      } catch (cause) {
        settle(asError(cause));
      }
    });
  };

  const ensureReady = async (): Promise<void> => {
    if (stopped) throw new Error("Pipecat sidecar has been stopped.");
    if (protocolFailure !== null) {
      const error = protocolFailure;
      protocolFailure = null;
      throw error;
    }
    if (startup !== null) return startup;
    if (child !== null) return;
    startup = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (cause?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cause === undefined) resolve();
        else reject(cause);
      };
      const timer = setTimeout(() => {
        const error = new Error("Pipecat sidecar did not become ready.");
        const timedOutChild = child;
        child = null;
        timedOutChild?.kill("SIGTERM");
        finish(error);
      }, startupTimeoutMs);
      try {
        output = "";
        stderrTail = "";
        child = spawn(input.executablePath, [...(input.arguments ?? [])], {
          env: {
            ...process.env,
            JARVIS_PIPECAT_MODEL_ROOT: input.modelRoot,
            ...(input.kokoroRoot === undefined
              ? {}
              : { JARVIS_PIPECAT_KOKORO_ROOT: input.kokoroRoot }),
            JARVIS_PIPECAT_PROTOCOL_VERSION: String(DESKTOP_PIPECAT_PROTOCOL_VERSION),
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }) as unknown as PipecatChild;
        const activeChild = child;
        attach(activeChild, finish);
      } catch (cause) {
        finish(asError(cause));
      }
    }).finally(() => {
      startup = null;
    });
    return startup;
  };

  const request = async (command: DesktopPipecatCommandInput): Promise<boolean> => {
    try {
      await ensureReady();
      await write({ ...command, requestId: `pipecat-${++sequence}` } as DesktopPipecatCommand);
      return true;
    } catch {
      return false;
    }
  };

  const api: DesktopPipecatSidecar = {
    ensureReady,
    startCapture: async (captureInput) => {
      if (captures.size > 0 || startingCaptures.size > 0) {
        throw new Error("Pipecat capture is already active.");
      }
      const pendingStart: PendingCaptureStart = { captureId: captureInput.captureId };
      startingCaptures.set(captureInput.captureId, pendingStart);
      let resolve!: (value: CaptureResult) => void;
      let reject!: (cause: Error) => void;
      const result = new Promise<CaptureResult>((resultResolve, resultReject) => {
        resolve = resultResolve;
        reject = resultReject;
      });
      captures.set(captureInput.captureId, {
        result,
        resolve,
        reject,
        ...(captureInput.onTranscript === undefined
          ? {}
          : { onTranscript: captureInput.onTranscript }),
        ...(captureInput.onTiming === undefined ? {} : { onTiming: captureInput.onTiming }),
        nextPcmSequence: 0,
        pcmTail: Promise.resolve(true),
        queuedPcmBytes: 0,
        pcmFailed: false,
      });
      result.catch(() => undefined);
      try {
        await ensureReady();
        const accepted = await request({
          type: "capture-start",
          captureId: captureInput.captureId,
          sampleRate: captureInput.sampleRate,
          channels: captureInput.channels,
          contextualPhrases: captureInput.contextualPhrases,
        });
        if (!accepted) {
          captures.delete(captureInput.captureId);
          throw new Error("Pipecat capture could not start.");
        }
        const action = pendingStart.action;
        if (action !== undefined) {
          const actionAccepted = await request(
            action === "release"
              ? { type: "capture-release", captureId: pendingStart.captureId }
              : { type: "capture-cancel", captureId: pendingStart.captureId },
          );
          pendingStart.resolveAction?.(actionAccepted);
          if (!actionAccepted) {
            captures.delete(captureInput.captureId);
            throw new Error(`Pipecat capture could not ${action}.`);
          }
        }
        return { result };
      } catch (cause) {
        captures.delete(captureInput.captureId);
        pendingStart.resolveAction?.(false);
        throw cause;
      } finally {
        startingCaptures.delete(captureInput.captureId);
      }
    },
    pushPcm: async (pcmInput) => {
      const capture = captures.get(pcmInput.captureId);
      if (capture === undefined) return false;
      const pcmBytes = pcmInput.samples.byteLength;
      if (capture.pcmFailed || capture.queuedPcmBytes + pcmBytes > MAX_QUEUED_PCM_BYTES) {
        capture.pcmFailed = true;
        return false;
      }
      capture.queuedPcmBytes += pcmBytes;
      const send = capture.pcmTail
        .then(async (previousAccepted) => {
          if (
            !previousAccepted ||
            capture.pcmFailed ||
            captures.get(pcmInput.captureId) !== capture
          ) {
            return false;
          }
          const chunks = floatPcmToInt16Chunks(pcmInput.samples, pcmInput.channels);
          for (const chunk of chunks) {
            const accepted = await request({
              type: "pcm",
              captureId: pcmInput.captureId,
              sequence: capture.nextPcmSequence,
              sampleRate: pcmInput.sampleRate,
              channels: pcmInput.channels,
              data: chunk.toString("base64"),
            });
            if (!accepted) {
              capture.pcmFailed = true;
              return false;
            }
            capture.nextPcmSequence += 1;
          }
          return true;
        })
        .finally(() => {
          capture.queuedPcmBytes -= pcmBytes;
        });
      capture.pcmTail = send;
      return await send;
    },
    releaseCapture: async (captureId) => {
      const startingCapture = startingCaptures.get(captureId);
      if (startingCapture !== undefined)
        return await rememberCaptureAction(startingCapture, "release");
      const capture = captures.get(captureId);
      if (capture === undefined || !(await capture.pcmTail)) return false;
      return await request({ type: "capture-release", captureId });
    },
    cancelCapture: async (captureId) => {
      const startingCapture = startingCaptures.get(captureId);
      if (startingCapture !== undefined)
        return await rememberCaptureAction(startingCapture, "cancel");
      const capture = captures.get(captureId);
      if (capture === undefined) return false;
      capture.pcmFailed = true;
      return await request({ type: "capture-cancel", captureId });
    },
    prepareSpeech: async () => request({ type: "speech-prepare" }),
    prepareListening: async () => request({ type: "listening-prepare" }),
    speak: async (speechInput) => {
      if (speeches.has(speechInput.speechId)) {
        throw new Error("Pipecat speech is already active.");
      }
      let resolve!: (value: DesktopPipecatSpeechResult) => void;
      let reject!: (cause: Error) => void;
      const result = new Promise<DesktopPipecatSpeechResult>((resultResolve, resultReject) => {
        resolve = resultResolve;
        reject = resultReject;
      });
      result.catch(() => undefined);
      const speech: SpeechState = {
        speechId: speechInput.speechId,
        result,
        resolve,
        reject,
        cancelRequested: false,
      };
      speeches.set(speech.speechId, speech);
      const accepted = await request({
        type: "speech-start",
        speechId: speech.speechId,
        text: speechInput.text,
      });
      if (!accepted) {
        speeches.delete(speech.speechId);
        throw new Error("Pipecat speech could not start.");
      }
      return await result;
    },
    cancelSpeech: async (speechId) => {
      const speech = speeches.get(speechId);
      if (speech === undefined) return false;
      speech.cancelRequested = true;
      const accepted = await request({ type: "speech-cancel", speechId });
      if (!accepted && speeches.get(speechId) === speech) {
        speeches.delete(speechId);
        speech.reject(new Error("Pipecat did not accept speech cancellation."));
      }
      return accepted;
    },
    transcribe: async (transcribeInput) => {
      if (!Number.isInteger(transcribeInput.sampleRate) || transcribeInput.sampleRate <= 0) {
        throw new Error("Pipecat transcription sample rate must be a positive integer.");
      }
      if (!Number.isInteger(transcribeInput.channels) || transcribeInput.channels <= 0) {
        throw new Error("Pipecat transcription channel count must be a positive integer.");
      }
      if (
        transcribeInput.audio.byteLength === 0 ||
        transcribeInput.audio.byteLength %
          (transcribeInput.channels * Int16Array.BYTES_PER_ELEMENT) !==
          0 ||
        transcribeInput.audio.byteLength >
          MAX_TRANSCRIPTION_DURATION_SECONDS *
            transcribeInput.sampleRate *
            transcribeInput.channels *
            Int16Array.BYTES_PER_ELEMENT
      ) {
        throw new Error("Pipecat transcription audio must be non-empty signed 16-bit PCM.");
      }
      const captureId = `transcribe-${++sequence}`;
      const started = await api.startCapture({
        captureId,
        sampleRate: transcribeInput.sampleRate,
        channels: transcribeInput.channels,
        contextualPhrases: transcribeInput.contextualPhrases ?? [],
      });
      const samples = new Float32Array(transcribeInput.audio.byteLength / 2);
      const view = new DataView(
        transcribeInput.audio.buffer,
        transcribeInput.audio.byteOffset,
        transcribeInput.audio.byteLength,
      );
      for (let index = 0; index < samples.length; index += 1) {
        const value = view.getInt16(index * 2, true);
        samples[index] = value < 0 ? value / 32_768 : value / 32_767;
      }
      const samplesPerChunk = Math.floor(MAX_QUEUED_PCM_BYTES / Float32Array.BYTES_PER_ELEMENT);
      for (let offset = 0; offset < samples.length; offset += samplesPerChunk) {
        if (
          !(await api.pushPcm({
            captureId,
            sampleRate: transcribeInput.sampleRate,
            channels: transcribeInput.channels,
            samples: samples.subarray(offset, offset + samplesPerChunk),
          }))
        ) {
          await api.cancelCapture(captureId);
          throw new Error("Pipecat transcription audio could not be sent.");
        }
      }
      if (!(await api.releaseCapture(captureId))) {
        throw new Error("Pipecat transcription could not finish.");
      }
      const result = await started.result;
      if (!result.ok) throw new Error(result.message);
      return result.text;
    },
    synthesize: async (text) => {
      if (text.trim().length === 0 || text.length > DESKTOP_PIPECAT_MAX_SYNTHESIS_TEXT_LENGTH) {
        throw new Error("Pipecat synthesis text is invalid.");
      }
      const synthesisId = `synthesis-${++sequence}`;
      let resolve!: (value: PipecatSynthesisResult) => void;
      let reject!: (cause: Error) => void;
      const result = new Promise<PipecatSynthesisResult>((resultResolve, resultReject) => {
        resolve = resultResolve;
        reject = resultReject;
      });
      result.catch(() => undefined);
      syntheses.set(synthesisId, {
        result,
        resolve,
        reject,
        chunks: [],
        nextSequence: 0,
        audioBytes: 0,
      });
      const accepted = await request({ type: "synthesis-start", synthesisId, text });
      if (!accepted) {
        syntheses.delete(synthesisId);
        throw new Error("Pipecat synthesis could not start.");
      }
      return await result;
    },
    cancel: async () => {
      for (const captureId of captures.keys()) await api.cancelCapture(captureId);
      for (const speechId of speeches.keys()) await api.cancelSpeech(speechId);
      for (const synthesisId of syntheses.keys()) {
        await request({ type: "synthesis-cancel", synthesisId });
      }
    },
    shutdown: async () => {
      if (stopped) return;
      const activeChild = child;
      if (activeChild !== null && activeChild.stdin !== null && !activeChild.stdin.destroyed) {
        try {
          await write({ type: "shutdown", requestId: `pipecat-${++sequence}` });
        } catch {
          // The process may already be gone. The cleanup below still runs.
        }
      }
      stopped = true;
      rejectAll(new Error("Pipecat sidecar shut down."));
      if (activeChild !== null && !activeChild.killed) activeChild.kill("SIGTERM");
    },
  };
  return api;

  function rememberCaptureAction(
    capture: PendingCaptureStart,
    action: "release" | "cancel",
  ): Promise<boolean> {
    if (capture.action !== undefined && capture.action !== action) return Promise.resolve(false);
    if (capture.actionResult !== undefined) return capture.actionResult;
    capture.action = action;
    capture.actionResult = new Promise<boolean>((resolve) => {
      capture.resolveAction = resolve;
    });
    return capture.actionResult;
  }
}
