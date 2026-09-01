import { describe, expect, it } from "vite-plus/test";

import { base64ToBytes, buildMobilePcmUtterance } from "./mobileVoiceAudio";

const pcm = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

describe("mobile Jarvis voice audio", () => {
  it("joins complete native int16 frames without changing their bytes", () => {
    const utterance = buildMobilePcmUtterance([
      { data: pcm(0, 0, 1, 0), sampleRate: 16_000, channels: 1 },
      { data: pcm(255, 127), sampleRate: 16_000, channels: 1 },
    ]);
    expect(utterance).toMatchObject({ format: "pcm-s16le", sampleRate: 16_000, channels: 1 });
    expect([...base64ToBytes(utterance.audioBase64)]).toEqual([0, 0, 1, 0, 255, 127]);
  });

  it("rejects missing audio and native format changes", () => {
    expect(() => buildMobilePcmUtterance([])).toThrow("No microphone audio");
    expect(() =>
      buildMobilePcmUtterance([
        { data: pcm(0, 0), sampleRate: 16_000, channels: 1 },
        { data: pcm(0, 0), sampleRate: 48_000, channels: 1 },
      ]),
    ).toThrow("format changed");
  });

  it("rejects more than fifteen seconds at the captured format", () => {
    expect(() =>
      buildMobilePcmUtterance([
        { data: new Uint8Array(480_002).buffer, sampleRate: 16_000, channels: 1 },
      ]),
    ).toThrow("fifteen-second limit");
  });
});
