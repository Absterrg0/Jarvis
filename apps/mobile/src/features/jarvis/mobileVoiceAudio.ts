import { jarvisVoiceMaxPcmBytes, type JarvisVoiceTranscribeInput } from "@t3tools/contracts";

export interface MobilePcmBuffer {
  readonly data: ArrayBuffer;
  readonly sampleRate: number;
  readonly channels: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let encoded = "";
  const chunkSize = 16_384;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    encoded += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(encoded);
}

export function base64ToBytes(value: string): Uint8Array {
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

/** Join one native int16 stream capture into one bounded RPC utterance. */
export function buildMobilePcmUtterance(
  buffers: ReadonlyArray<MobilePcmBuffer>,
): JarvisVoiceTranscribeInput {
  const first = buffers[0];
  if (first === undefined) throw new Error("No microphone audio was captured.");
  if (
    !Number.isInteger(first.sampleRate) ||
    !Number.isInteger(first.channels) ||
    first.sampleRate < 8_000 ||
    first.sampleRate > 48_000 ||
    first.channels < 1 ||
    first.channels > 2
  ) {
    throw new Error("The microphone returned an unsupported audio format.");
  }
  let byteLength = 0;
  const maximumByteLength = jarvisVoiceMaxPcmBytes(first.sampleRate, first.channels);
  for (const buffer of buffers) {
    if (buffer.sampleRate !== first.sampleRate || buffer.channels !== first.channels) {
      throw new Error("The microphone audio format changed during capture.");
    }
    if (buffer.data.byteLength % (first.channels * Int16Array.BYTES_PER_ELEMENT) !== 0) {
      throw new Error("The microphone returned an incomplete signed-PCM frame.");
    }
    byteLength += buffer.data.byteLength;
    if (byteLength > maximumByteLength) {
      throw new Error("Voice capture exceeded the fifteen-second limit.");
    }
  }
  if (byteLength === 0) throw new Error("No microphone audio was captured.");
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const buffer of buffers) {
    const chunk = new Uint8Array(buffer.data);
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    format: "pcm-s16le",
    audioBase64: bytesToBase64(bytes),
    sampleRate: first.sampleRate,
    channels: first.channels,
  };
}
