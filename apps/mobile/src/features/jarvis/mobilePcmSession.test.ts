import { describe, expect, it } from "@effect/vitest";
import { createMobilePcmSession, segmentMobilePcmSpeech } from "./mobilePcmSession";

const chunk = { sequence: 0, sampleRate: 24_000, channels: 1, pcmBase64: "AAA=" } as const;
describe("mobile PCM session", () => {
  it("delivers the first chunk before stream completion", async () => {
    const received: number[] = [];
    const session = createMobilePcmSession({
      write: async (part) => {
        received.push(part.sequence);
      },
    });
    await session.write(chunk);
    expect(received).toEqual([0]);
    await session.write({ ...chunk, sequence: 1 });
    session.finish();
    expect(received).toEqual([0, 1]);
  });
  it("rejects stale chunks after cancellation", async () => {
    const session = createMobilePcmSession({ write: async () => undefined });
    session.cancel();
    await expect(session.write(chunk)).rejects.toThrow("cancelled");
    expect(session.finish).toThrow();
  });
  it("waits for native backpressure and invalidates an interrupted write", async () => {
    const pending = Promise.withResolvers<void>();
    const session = createMobilePcmSession({ write: () => pending.promise });
    const writing = session.write(chunk);
    session.cancel();
    pending.resolve();
    await expect(writing).rejects.toThrow("cancelled");
  });
  it("rejects missing chunks and incomplete PCM", async () => {
    for (const invalid of [
      { ...chunk, sequence: 1 },
      { ...chunk, pcmBase64: "AA==" },
      { ...chunk, pcmBase64: "!" },
    ]) {
      const session = createMobilePcmSession({ write: async () => undefined });
      await expect(session.write(invalid)).rejects.toThrow("malformed");
    }
  });
  it("rejects chunks written after finish", async () => {
    const received: number[] = [];
    const session = createMobilePcmSession({
      write: async (part) => {
        received.push(part.sequence);
      },
    });
    await session.write(chunk);
    session.finish();
    await expect(session.write({ ...chunk, sequence: 1 })).rejects.toThrow("finished");
    expect(received).toEqual([0]);
  });
  it("does not report empty audio as completed", () => {
    expect(createMobilePcmSession({ write: async () => undefined }).finish).toThrow();
  });
});

it("keeps ordinary reports in one stream and preserves long report words", () => {
  const short = "Version 3.14 is ready. Two checks passed.";
  expect(segmentMobilePcmSpeech(short)).toEqual([short]);
  const long = "Please verify the project. ".repeat(150).trim();
  const parts = segmentMobilePcmSpeech(long);
  expect(parts.every((part) => part.length <= 2000)).toBe(true);
  expect(parts.join(" ")).toBe(long);
});
