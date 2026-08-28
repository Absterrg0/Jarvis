export const jarvisSpeechTrailingSilenceMs = 140;

export type ContinuousSpeechSink = {
  readonly write: (samples: Float32Array) => void;
  readonly close: () => void;
};

export type ContinuousSpeechPlayback = {
  readonly write: (samples: Float32Array) => Promise<void>;
  readonly finish: () => Promise<void>;
  readonly abort: () => void;
};

/** Gives native players a real audio tail so the final phoneme reaches the device. */
export function appendSpeechTrailingSilence(
  samples: Float32Array,
  sampleRate: number,
  trailingSilenceMs = jarvisSpeechTrailingSilenceMs,
): Float32Array {
  if (samples.length === 0 || sampleRate <= 0 || trailingSilenceMs <= 0) return samples;
  const silenceSamples = Math.max(1, Math.round((sampleRate * trailingSilenceMs) / 1_000));
  const padded = new Float32Array(samples.length + silenceSamples);
  padded.set(samples);
  return padded;
}

/** Paces every Kokoro chunk through one device stream and closes it only once. */
export function createContinuousSpeechPlayback(input: {
  readonly sampleRate: number;
  readonly open: () => ContinuousSpeechSink;
  readonly wait: (durationMs: number) => Promise<void>;
  readonly frameSamples?: number;
  readonly aborted?: () => boolean;
}): ContinuousSpeechPlayback {
  const frameSamples = Math.max(1, input.frameSamples ?? 1_024);
  let sink: ContinuousSpeechSink | undefined;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    sink?.close();
  };
  const write = async (samples: Float32Array): Promise<void> => {
    if (closed || samples.length === 0 || input.aborted?.() === true) return;
    sink ??= input.open();
    for (let offset = 0; offset < samples.length; offset += frameSamples) {
      if (closed || input.aborted?.() === true) return;
      const frame = samples.subarray(offset, Math.min(offset + frameSamples, samples.length));
      sink.write(frame);
      await input.wait((frame.length / input.sampleRate) * 1_000);
    }
  };

  return {
    write,
    finish: async () => {
      if (closed) return;
      if (sink !== undefined && input.aborted?.() !== true) {
        const silenceSamples = Math.max(
          1,
          Math.round((input.sampleRate * jarvisSpeechTrailingSilenceMs) / 1_000),
        );
        await write(new Float32Array(silenceSamples));
      }
      close();
    },
    abort: close,
  };
}
