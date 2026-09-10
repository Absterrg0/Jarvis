import { Directory, File, Paths } from "expo-file-system";

import { uuidv4 } from "../../lib/uuid";

export const JARVIS_LOCAL_ASR_SAMPLE_RATE = 16_000;
const JARVIS_LOCAL_ASR_MAX_PCM_BYTES = 8_000_000;

/**
 * Encode mono 16-bit PCM bytes as a WAV file.
 *
 * Pure and statically tested. `pcmBytes` are little-endian signed 16-bit
 * samples at `sampleRate` Hz. Throws an honest error on empty input, odd
 * length, or an utterance over the byte bound instead of truncating audio.
 */
export function encodeWavPcm16Mono(pcmBytes: Uint8Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("Local transcription needs a valid sample rate.");
  }
  if (pcmBytes.length === 0) throw new Error("No speech was detected.");
  if (pcmBytes.length % 2 !== 0) throw new Error("Speech audio is malformed.");
  if (pcmBytes.length > JARVIS_LOCAL_ASR_MAX_PCM_BYTES) {
    throw new Error("Speech is too long for on-device transcription.");
  }
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcmBytes.length, true);
  const output = new Uint8Array(44 + pcmBytes.length);
  output.set(new Uint8Array(header), 0);
  output.set(pcmBytes, 44);
  return output;
}

/** Concatenate streamed PCM capture buffers without copying twice per chunk. */
export function concatPcmBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function pcmBytesFromCaptureBuffers(
  buffers: ReadonlyArray<{ readonly data: ArrayBuffer }>,
): Uint8Array {
  return concatPcmBytes(buffers.map((buffer) => new Uint8Array(buffer.data.slice(0))));
}

/**
 * Write one bounded WAV temp file for file-based local transcription (iOS).
 * Callers delete through `deleteLocalAsrFile` in a finally block. The live
 * Android path never calls this; its `uri` argument is a sentinel.
 */
export function writeLocalAsrWavFile(wavBytes: Uint8Array): string {
  const file = new File(Paths.cache, `jarvis-asr-${uuidv4()}.wav`);
  file.write(wavBytes);
  return file.uri;
}

export function deleteLocalAsrFile(uri: string | null): void {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {
    // Temp cleanup is best-effort; a missing file owns no state.
  }
}

export function localAsrCacheDirectory(): Directory {
  return new Directory(Paths.cache);
}
