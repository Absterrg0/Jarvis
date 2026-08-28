import { describe, expect, it } from "@effect/vitest";

import {
  appendSpeechTrailingSilence,
  createContinuousSpeechPlayback,
  jarvisSpeechTrailingSilenceMs,
} from "./speech-audio.ts";

describe("speech audio", () => {
  it("keeps the final phoneme and adds a silent playback tail", () => {
    const speech = Float32Array.from([0.4, -0.2, 0.1]);
    const padded = appendSpeechTrailingSilence(speech, 1_000);

    expect(padded.slice(0, speech.length)).toEqual(speech);
    expect(padded.length).toBe(speech.length + jarvisSpeechTrailingSilenceMs);
    expect(padded.slice(speech.length).every((sample) => sample === 0)).toBe(true);
  });

  it("does not invent audio for an empty chunk", () => {
    expect(appendSpeechTrailingSilence(new Float32Array(), 24_000)).toHaveLength(0);
  });

  it("uses one output stream for every synthesized chunk and adds one final tail", async () => {
    const writes: Array<Float32Array> = [];
    let opened = 0;
    let closed = 0;
    const playback = createContinuousSpeechPlayback({
      sampleRate: 1_000,
      open: () => {
        opened += 1;
        return {
          write: (samples) => writes.push(Float32Array.from(samples)),
          close: () => {
            closed += 1;
          },
        };
      },
      wait: async () => undefined,
      frameSamples: 1_000,
    });

    await playback.write(Float32Array.from([0.1, 0.2]));
    await playback.write(Float32Array.from([0.3]));
    await playback.finish();

    expect(opened).toBe(1);
    expect(closed).toBe(1);
    expect(writes.slice(0, 2)).toEqual([Float32Array.from([0.1, 0.2]), Float32Array.from([0.3])]);
    expect(writes).toHaveLength(3);
    expect(writes[2]).toHaveLength(jarvisSpeechTrailingSilenceMs);
    expect(writes[2]?.every((sample) => sample === 0)).toBe(true);
  });
});
