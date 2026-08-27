import * as IpcChannels from "../ipc/channels.ts";

// @effect-diagnostics cryptoRandomUUID:off

type Accepted = { readonly accepted: boolean };

export interface RendererPcmCaptureDependencies {
  readonly requestPermission: () => Promise<Accepted>;
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly AudioContext: new (options?: AudioContextOptions) => AudioContext;
  readonly AudioWorkletNode: new (
    context: AudioContext,
    name: string,
    options?: AudioWorkletNodeOptions,
  ) => AudioWorkletNode;
  readonly Blob: typeof Blob;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly invoke: (channel: string, payload: unknown) => Promise<Accepted>;
  readonly send: (channel: string, payload: unknown) => void;
  readonly randomUUID: () => string;
  readonly onError?: (message: string) => void;
}

export interface RendererPcmCaptureController {
  readonly start: (input?: {
    readonly purpose?: "command" | "diagnostic";
    readonly captureId?: string;
    readonly contextualPhrases?: ReadonlyArray<string>;
  }) => Promise<Accepted>;
  readonly release: () => Promise<Accepted>;
  readonly cancel: () => Promise<Accepted>;
  readonly dispose: () => Promise<void>;
}

const workletSource = `
class JarvisPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === "stop") this.stopped = true;
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      const samples = channel.slice(0);
      this.port.postMessage({ type: "samples", sampleRate, samples }, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor("jarvis-pcm-capture", JarvisPcmCaptureProcessor);
`;

export function createRendererPcmCaptureController(
  dependencies: RendererPcmCaptureDependencies,
): RendererPcmCaptureController {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let silentSink: GainNode | null = null;
  let workletUrl: string | null = null;
  let sessionId: string | null = null;
  let generation = 0;
  let active = false;
  let starting = false;
  let disposed = false;
  let startToken = 0;
  let cancelling = false;
  let batch = new Float32Array(0);
  let batchSamples = 0;
  const pending = new Set<Promise<unknown>>();

  const teardown = async (): Promise<void> => {
    active = false;
    batch = new Float32Array(0);
    batchSamples = 0;
    try {
      worklet?.port.postMessage({ type: "stop" });
    } catch {}
    try {
      worklet?.port.close();
    } catch {}
    try {
      source?.disconnect();
    } catch {}
    try {
      worklet?.disconnect();
    } catch {}
    try {
      silentSink?.disconnect();
    } catch {}
    for (const track of stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {}
    }
    try {
      await context?.close();
    } catch {}
    if (workletUrl !== null) {
      try {
        dependencies.revokeObjectURL(workletUrl);
      } catch {}
    }
    stream = null;
    source = null;
    worklet = null;
    silentSink = null;
    context = null;
    workletUrl = null;
    sessionId = null;
    try {
      dependencies.send(IpcChannels.JARVIS_VOICE_CAPTURE_RENDERER_THROTTLING_CHANNEL, false);
    } catch {}
  };

  const sendFrame = (samples: Float32Array): void => {
    if (sessionId === null) return;
    const framePromise = dependencies
      .invoke(IpcChannels.JARVIS_VOICE_CAPTURE_PUSH_PCM_FRAME_CHANNEL, {
        sessionId,
        generation,
        samples,
      })
      .then((result) => {
        if (!result.accepted) {
          dependencies.onError?.("Microphone audio delivery was rejected.");
          void cancel();
        }
        return result;
      })
      .catch(() => {
        dependencies.onError?.("Microphone audio delivery failed.");
        void cancel();
        return { accepted: false };
      });
    pending.add(framePromise);
    void framePromise.finally(() => pending.delete(framePromise));
  };

  const enqueue = (samples: Float32Array): void => {
    if (!active || sessionId === null) return;
    const combined = new Float32Array(batch.length + samples.length);
    combined.set(batch);
    combined.set(samples, batch.length);
    let offset = 0;
    while (batchSamples > 0 && combined.length - offset >= batchSamples) {
      const frame = combined.slice(offset, offset + batchSamples);
      sendFrame(frame);
      offset += batchSamples;
    }
    batch = combined.slice(offset);
  };

  const flush = (): void => {
    if (batch.length > 0) {
      const finalBatch = batch;
      batch = new Float32Array(0);
      sendFrame(finalBatch);
    }
  };

  const reportCaptureError = (cause: unknown): void => {
    const name =
      typeof cause === "object" &&
      cause !== null &&
      "name" in cause &&
      typeof cause.name === "string"
        ? cause.name
        : "";
    if (name === "NotAllowedError") {
      dependencies.onError?.("Microphone permission was denied.");
    } else if (name === "NotFoundError") {
      dependencies.onError?.("No microphone device was found.");
    } else {
      dependencies.onError?.(
        `Microphone capture failed${cause instanceof Error ? `: ${cause.message}` : "."}`,
      );
    }
  };

  const start = async (input?: {
    readonly purpose?: "command" | "diagnostic";
    readonly captureId?: string;
    readonly contextualPhrases?: ReadonlyArray<string>;
  }): Promise<Accepted> => {
    if (disposed || active || starting) return { accepted: false };
    starting = true;
    const token = ++startToken;
    try {
      const permission = await dependencies.requestPermission();
      if (!permission.accepted) {
        dependencies.onError?.("Microphone permission was denied.");
        starting = false;
        return permission;
      }
      if (disposed || token !== startToken) {
        starting = false;
        return { accepted: false };
      }
      try {
        dependencies.send(IpcChannels.JARVIS_VOICE_CAPTURE_RENDERER_THROTTLING_CHANNEL, true);
      } catch {}
      stream = await dependencies.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (disposed || token !== startToken) {
        await teardown();
        starting = false;
        return { accepted: false };
      }
      context = new dependencies.AudioContext();
      batchSamples = Math.max(1, Math.round(context.sampleRate / 50));
      workletUrl = dependencies.createObjectURL(
        new dependencies.Blob([workletSource], { type: "application/javascript" }),
      );
      await context.audioWorklet.addModule(workletUrl);
      source = context.createMediaStreamSource(stream);
      worklet = new dependencies.AudioWorkletNode(context, "jarvis-pcm-capture");
      worklet.port.onmessage = (event: MessageEvent) => {
        const value = event.data as { type?: unknown; sampleRate?: unknown; samples?: unknown };
        if (
          value.type === "samples" &&
          typeof value.sampleRate === "number" &&
          value.samples instanceof Float32Array
        ) {
          enqueue(value.samples);
        }
      };
      worklet.port.onmessageerror = () => {
        dependencies.onError?.("Microphone audio processing failed.");
        void cancel();
      };
      await context.resume();
      sessionId = dependencies.randomUUID();
      generation += 1;
      if (disposed || token !== startToken) {
        await teardown();
        starting = false;
        return { accepted: false };
      }
      const result = await dependencies.invoke(IpcChannels.JARVIS_VOICE_CAPTURE_START_CHANNEL, {
        purpose: input?.purpose ?? "command",
        ...(input?.captureId === undefined ? {} : { captureId: input.captureId }),
        ...(input?.contextualPhrases === undefined
          ? {}
          : { contextualPhrases: input.contextualPhrases }),
        source: {
          type: "renderer-pcm",
          sessionId,
          generation,
          sampleRate: context.sampleRate,
          channels: 1,
        },
      });
      if (disposed || token !== startToken) {
        if (result.accepted) {
          await dependencies.invoke(IpcChannels.JARVIS_VOICE_CAPTURE_CANCEL_CHANNEL, undefined);
        }
        await teardown();
        starting = false;
        return { accepted: false };
      }
      if (!result.accepted) {
        await teardown();
        starting = false;
        return result;
      }
      active = true;
      starting = false;
      source.connect(worklet);
      silentSink = context.createGain();
      silentSink.gain.value = 0;
      worklet.connect(silentSink);
      silentSink.connect(context.destination);
      return result;
    } catch (cause) {
      if (disposed || token !== startToken) {
        await teardown();
        starting = false;
        return { accepted: false };
      }
      reportCaptureError(cause);
      await teardown();
      starting = false;
      return { accepted: false };
    }
  };

  const release = async (): Promise<Accepted> => {
    if (!active || sessionId === null) return { accepted: false };
    let result: Accepted = { accepted: false };
    try {
      flush();
      active = false;
      await Promise.allSettled([...pending]);
      result = await dependencies.invoke(
        IpcChannels.JARVIS_VOICE_CAPTURE_RELEASE_CHANNEL,
        undefined,
      );
    } catch {
      result = { accepted: false };
    } finally {
      await teardown();
    }
    return result;
  };

  const cancel = async (): Promise<Accepted> => {
    if (cancelling) return { accepted: false };
    cancelling = true;
    let result: Accepted = { accepted: false };
    try {
      if (!active) {
        startToken += 1;
        starting = false;
        return result;
      }
      active = false;
      result = await dependencies.invoke(
        IpcChannels.JARVIS_VOICE_CAPTURE_CANCEL_CHANNEL,
        undefined,
      );
    } catch {
      result = { accepted: false };
    } finally {
      await teardown();
      cancelling = false;
    }
    return result;
  };

  return {
    start,
    release,
    cancel,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await cancel();
    },
  };
}

export function createDefaultRendererPcmCaptureController(
  invoke: RendererPcmCaptureDependencies["invoke"],
  send: RendererPcmCaptureDependencies["send"],
  onError?: RendererPcmCaptureDependencies["onError"],
): RendererPcmCaptureController {
  return createRendererPcmCaptureController({
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    AudioContext: window.AudioContext,
    AudioWorkletNode: window.AudioWorkletNode,
    Blob: window.Blob,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    invoke,
    send,
    randomUUID: () => crypto.randomUUID(),
    requestPermission: () => invoke(IpcChannels.JARVIS_VOICE_CAPTURE_PERMISSION_CHANNEL, undefined),
    ...(onError === undefined ? {} : { onError }),
  });
}
