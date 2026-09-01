const MAX_SPEECH_SEGMENT_LENGTH = 240;

/** Split bounded presentation copy into playable segments without changing word order. */
export function segmentMobileSpeech(text: string): ReadonlyArray<string> {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return [];
  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [normalized];
  const segments: string[] = [];
  for (const sentence of sentences) {
    const words = sentence.trim().split(" ");
    let current = "";
    for (const word of words) {
      if (word.length > MAX_SPEECH_SEGMENT_LENGTH) {
        if (current.length > 0) segments.push(current);
        current = "";
        for (let offset = 0; offset < word.length; offset += MAX_SPEECH_SEGMENT_LENGTH) {
          const chunk = word.slice(offset, offset + MAX_SPEECH_SEGMENT_LENGTH);
          if (chunk.length === MAX_SPEECH_SEGMENT_LENGTH) segments.push(chunk);
          else current = chunk;
        }
        continue;
      }
      const next = current.length === 0 ? word : `${current} ${word}`;
      if (next.length <= MAX_SPEECH_SEGMENT_LENGTH) {
        current = next;
        continue;
      }
      if (current.length > 0) segments.push(current);
      current = word;
    }
    if (current.length > 0) segments.push(current);
  }
  return segments;
}
