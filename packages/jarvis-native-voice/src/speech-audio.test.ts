import { describe, expect, it } from "@effect/vitest";

import { appendSpeechTrailingSilence, jarvisSpeechTrailingSilenceMs } from "./speech-audio.ts";

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
});
