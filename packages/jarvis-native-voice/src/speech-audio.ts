export const jarvisSpeechTrailingSilenceMs = 140;

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
