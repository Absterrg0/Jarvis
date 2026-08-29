// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeModule from "node:module";
import * as NodeTimersPromises from "node:timers/promises";

import { createContinuousSpeechPlayback } from "./speech-audio.ts";

export type NodeCpalSpeechOutputRuntime = {
  readonly getDefaultOutputDevice: () => { readonly deviceId: string };
  readonly getDefaultOutputConfig: (deviceId: string) => {
    readonly sampleRate: number;
    readonly channels: number;
    readonly sampleFormat: "i16" | "u16" | "f32";
  };
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
  let closeError: unknown;
  const device = runtime.getDefaultOutputDevice();
  const config = runtime.getDefaultOutputConfig(device.deviceId);
  if (!Number.isInteger(config.sampleRate) || config.sampleRate <= 0) {
    throw new Error("node-cpal returned an invalid output sample rate.");
  }
  if (!Number.isInteger(config.channels) || config.channels <= 0) {
    throw new Error("node-cpal returned an invalid output channel count.");
  }
  const outputSampleRate = config.sampleRate;
  const outputChannels = config.channels;

  const resample = (
    samples: Float32Array,
    sampleRate: number,
    targetRate: number,
  ): Float32Array => {
    if (sampleRate === targetRate) return samples;
    const length = Math.max(1, Math.round((samples.length * targetRate) / sampleRate));
    const converted = new Float32Array(length);
    const ratio = sampleRate / targetRate;
    for (let index = 0; index < length; index += 1) {
      const source = index * ratio;
      const lower = Math.min(samples.length - 1, Math.floor(source));
      const upper = Math.min(samples.length - 1, lower + 1);
      const fraction = source - lower;
      converted[index] = samples[lower]! + (samples[upper]! - samples[lower]!) * fraction;
    }
    return converted;
  };

  const adaptToOutput = (samples: Float32Array): Float32Array => {
    const resampled = resample(samples, input.sampleRate, outputSampleRate);
    if (outputChannels === 1) return resampled;
    const converted = new Float32Array(resampled.length * outputChannels);
    for (let index = 0; index < resampled.length; index += 1) {
      for (let channel = 0; channel < outputChannels; channel += 1) {
        converted[index * outputChannels + channel] = resampled[index]!;
      }
    }
    return converted;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (stream !== undefined) {
      try {
        runtime.closeStream(stream);
      } catch (cause) {
        closeError ??= cause;
      }
    }
  };
  const open = () => {
    stream ??= runtime.createStream(
      device.deviceId,
      false,
      { sampleRate: outputSampleRate, channels: outputChannels, sampleFormat: "f32" },
      () => undefined,
    );
    return {
      write: (samples: Float32Array) => runtime.writeToStream(stream!, samples),
      close,
    };
  };
  const playback = createContinuousSpeechPlayback({
    sampleRate: outputSampleRate,
    channels: outputChannels,
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
    try {
      await playback.write(adaptToOutput(samples));
    } catch (cause) {
      playback.abort();
      throw cause;
    }
  };

  return {
    write,
    finish: async () => {
      if (closed) return;
      try {
        await playback.finish();
      } catch (cause) {
        playback.abort();
        throw cause;
      }
      if (closeError !== undefined) throw closeError;
    },
    abort: () => {
      close();
      playback.abort();
    },
  };
}
