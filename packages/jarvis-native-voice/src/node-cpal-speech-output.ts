// oxlint-disable t3code/no-global-process-runtime -- this is the native audio boundary.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeModule from "node:module";
import * as NodeTimersPromises from "node:timers/promises";

import { createContinuousSpeechPlayback } from "./speech-audio.ts";

export type NodeCpalSpeechOutputRuntime = {
  readonly getDefaultOutputDevice: () => { readonly deviceId: string };
  readonly createStream: (
    deviceId: string,
    isInput: boolean,
    config: {
      readonly sampleRate: number;
      readonly channels: number;
      readonly sampleFormat: "f32";
    },
    onData?: () => void,
  ) => string;
  readonly writeToStream: (stream: string, samples: Float32Array) => void;
  readonly closeStream: (stream: string) => void;
};

export type NodeCpalSpeechOutput = {
  /** Resolves after the PCM's device-duration pacing has been consumed. */
  readonly write: (pcm: Uint8Array) => Promise<void>;
  readonly finish: () => Promise<void>;
  readonly abort: () => void;
};

const require = NodeModule.createRequire(import.meta.url);

function loadNodeCpal(): NodeCpalSpeechOutputRuntime {
  return require("node-cpal") as NodeCpalSpeechOutputRuntime;
}

/** Writes Pipecat's signed-int16 mono frames directly to one node-cpal stream. */
export function createNodeCpalSpeechOutput(input: {
  readonly sampleRate: number;
  readonly channels?: number;
  readonly runtime?: NodeCpalSpeechOutputRuntime;
  readonly wait?: (durationMs: number) => Promise<void>;
}): NodeCpalSpeechOutput {
  if (!Number.isInteger(input.sampleRate) || input.sampleRate <= 0) {
    throw new Error("Speech output sample rate must be a positive integer.");
  }
  if ((input.channels ?? 1) !== 1) {
    throw new Error("Speech output requires mono PCM.");
  }
  const runtime = input.runtime ?? loadNodeCpal();
  const wait = input.wait ?? ((durationMs: number) => NodeTimersPromises.setTimeout(durationMs));
  let stream: string | undefined;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (stream !== undefined) runtime.closeStream(stream);
  };
  const open = () => {
    stream ??= runtime.createStream(
      runtime.getDefaultOutputDevice().deviceId,
      false,
      { sampleRate: input.sampleRate, channels: 1, sampleFormat: "f32" },
      () => undefined,
    );
    return {
      write: (samples: Float32Array) => runtime.writeToStream(stream!, samples),
      close,
    };
  };
  const playback = createContinuousSpeechPlayback({
    sampleRate: input.sampleRate,
    frameSamples: 1_024,
    open,
    wait,
    aborted: () => closed,
  });
  const write = async (pcm: Uint8Array): Promise<void> => {
    if (closed || pcm.byteLength === 0) return;
    if (pcm.byteLength % 2 !== 0) throw new Error("Speech output PCM must contain int16 samples.");
    const samples = new Float32Array(pcm.byteLength / 2);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let index = 0; index < samples.length; index += 1) {
      const value = view.getInt16(index * 2, true);
      samples[index] = value < 0 ? value / 32_768 : value / 32_767;
    }
    await playback.write(samples);
  };

  return {
    write,
    finish: async () => {
      if (closed) return;
      await playback.finish();
    },
    abort: () => {
      close();
      playback.abort();
    },
  };
}
