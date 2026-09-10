import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-file-system", () => ({
  File: class {},
  Directory: class {},
  Paths: { cache: "file:///cache/" },
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "test-uuid" }));

import { concatPcmBytes, encodeWavPcm16Mono } from "./mobileLocalAsrAudio";

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

describe("encodeWavPcm16Mono", () => {
  it("writes a valid 16k mono header around the samples", () => {
    const pcm = new Uint8Array([1, 0, 255, 255]);
    const wav = encodeWavPcm16Mono(pcm, 16_000);
    expect(wav.length).toBe(48);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");
    const view = new DataView(wav.buffer, wav.byteOffset);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect([...wav.slice(44)]).toEqual([1, 0, 255, 255]);
  });

  it("rejects empty, malformed, and over-bound audio instead of truncating", () => {
    expect(() => encodeWavPcm16Mono(new Uint8Array([]), 16_000)).toThrow("No speech");
    expect(() => encodeWavPcm16Mono(new Uint8Array([1]), 16_000)).toThrow("malformed");
    expect(() => encodeWavPcm16Mono(new Uint8Array(8_000_002), 16_000)).toThrow("too long");
    expect(() => encodeWavPcm16Mono(new Uint8Array([0, 0]), 0)).toThrow("sample rate");
  });
});

describe("concatPcmBytes", () => {
  it("joins streamed chunks in order", () => {
    const joined = concatPcmBytes([
      new Uint8Array([1, 2]),
      new Uint8Array([]),
      new Uint8Array([3]),
    ]);
    expect([...joined]).toEqual([1, 2, 3]);
  });
});
