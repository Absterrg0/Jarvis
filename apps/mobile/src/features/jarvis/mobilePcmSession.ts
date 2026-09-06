import { jarvisVoiceBase64ByteLength, type JarvisVoiceAudioChunk } from "@t3tools/contracts";

/** A stream belongs to one request, with no replay after interruption. */
export function createMobilePcmSession(input: {
  readonly write: (chunk: JarvisVoiceAudioChunk) => Promise<void>;
}) {
  let sequence = 0;
  let bytes = 0;
  let cancelled = false;
  let writing = false;
  let finished = false;
  return {
    cancel: () => {
      cancelled = true;
    },
    write: async (chunk: JarvisVoiceAudioChunk) => {
      if (cancelled) throw new Error("Speech was cancelled.");
      if (finished) throw new Error("Speech already finished.");
      const length = jarvisVoiceBase64ByteLength(chunk.pcmBase64);
      if (
        writing ||
        chunk.sequence !== sequence ||
        chunk.sampleRate !== 24_000 ||
        chunk.channels !== 1 ||
        length === null ||
        length === 0 ||
        length % 2 !== 0 ||
        length > 45_000 ||
        bytes + length > 8_000_000
      ) {
        cancelled = true;
        throw new Error("Speech audio is malformed, out of order, or exceeds its limit.");
      }
      writing = true;
      try {
        await input.write(chunk);
        if (cancelled) throw new Error("Speech was cancelled.");
        sequence += 1;
        bytes += length;
      } catch (cause) {
        cancelled = true;
        throw cause;
      } finally {
        writing = false;
      }
    },
    finish: () => {
      if (cancelled || writing || bytes === 0)
        throw new Error("Speech ended without a complete audio stream.");
      finished = true;
    },
  };
}

/** Most reports use one stream; split only at the RPC's text limit. */
export function segmentMobilePcmSpeech(text: string, limit = 2_000): ReadonlyArray<string> {
  let remaining = text.replace(/\s+/gu, " ").trim();
  const parts: string[] = [];
  while (remaining.length > limit) {
    const end = remaining.lastIndexOf(" ", limit);
    if (end <= 0) throw new Error("The spoken text contains a word that exceeds the speech limit.");
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end + 1);
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}
