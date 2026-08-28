import { describe, expect, it } from "@effect/vitest";

import {
  DESKTOP_PIPECAT_MAX_LINE_BYTES,
  encodeDesktopPipecatCommand,
  floatPcmToInt16Chunks,
  parseDesktopPipecatMessage,
} from "./DesktopPipecatProtocol.ts";

describe("Desktop Pipecat protocol", () => {
  it("preserves raw transcript text and accepts text-free STT timing", () => {
    expect(
      parseDesktopPipecatMessage({
        type: "transcript",
        captureId: "capture-1",
        text: "check out Zivil",
      }),
    ).toEqual({ type: "transcript", captureId: "capture-1", text: "check out Zivil" });
    expect(
      parseDesktopPipecatMessage({
        type: "stt-timing",
        timing: {
          engineId: "pipecat-parakeet-tdt-ctc-110m-int8",
          captureId: "capture-1",
          start: "warm",
          modelLoadMs: 0,
          pipelineReadyMs: 12,
          firstAudioMs: 25,
          captureMs: 400,
          audioDurationMs: 350,
          releaseToTranscriptMs: 80,
          resampleMs: 2,
          decodeMs: 75,
          totalMs: 480,
          audioBytes: 11_200,
          chunkCount: 3,
          peakRssBytes: 50_000_000,
        },
      }),
    ).not.toBeNull();
  });

  it("bounds signed 16-bit PCM protocol lines below 64 KiB", () => {
    const chunks = floatPcmToInt16Chunks(new Float32Array(100_000).fill(2));
    expect(chunks.length).toBeGreaterThan(1);
    for (const [sequence, chunk] of chunks.entries()) {
      const line = encodeDesktopPipecatCommand({
        type: "pcm",
        requestId: `request-${sequence}`,
        captureId: "capture-1",
        sequence,
        sampleRate: 48_000,
        channels: 1,
        data: chunk.toString("base64"),
      });
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(DESKTOP_PIPECAT_MAX_LINE_BYTES + 1);
      expect(chunk.readInt16LE(0)).toBe(32_767);
    }
  });

  it("never splits an interleaved channel frame between protocol chunks", () => {
    const samples = new Float32Array(45_006);
    const chunks = floatPcmToInt16Chunks(samples, 6);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.byteLength % (6 * 2) === 0)).toBe(true);
    expect(chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(
      samples.byteLength / 2,
    );
  });

  it("rejects malformed timing and oversized context commands", () => {
    expect(parseDesktopPipecatMessage({ type: "ready", version: 1 })).toBeNull();
    expect(() =>
      encodeDesktopPipecatCommand({
        type: "capture-start",
        requestId: "request",
        captureId: "capture",
        sampleRate: 16_000,
        channels: 1,
        contextualPhrases: ["x".repeat(DESKTOP_PIPECAT_MAX_LINE_BYTES)],
      }),
    ).toThrow(/64 KiB/u);
  });
});
