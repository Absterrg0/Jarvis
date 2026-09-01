const MAX_SPEECH_SEGMENT_LENGTH = 240;

export type MobileSpeechPrefetch<TItem, TAudio> = {
  readonly cancel: () => void;
  readonly enqueue: (items: ReadonlyArray<TItem>) => void;
  readonly playbackFinished: () => void;
  readonly playbackStarted: () => void;
  readonly takeNext: () => Promise<{ readonly item: TItem; readonly audio: TAudio } | undefined>;
};

type PendingSynthesis<TItem, TAudio> = {
  readonly controller: AbortController;
  readonly item: TItem;
  readonly promise: Promise<TAudio>;
  settled: boolean;
};

/** Keeps one synthesized segment ahead of the segment currently playing. */
export function createMobileSpeechPrefetch<TItem, TAudio>(input: {
  readonly synthesize: (item: TItem, signal: AbortSignal) => Promise<TAudio>;
}): MobileSpeechPrefetch<TItem, TAudio> {
  let generation = 0;
  let queued: TItem[] = [];
  let current: PendingSynthesis<TItem, TAudio> | null = null;
  let lookahead: PendingSynthesis<TItem, TAudio> | null = null;

  const begin = (item: TItem): PendingSynthesis<TItem, TAudio> => {
    const controller = new AbortController();
    let promise: Promise<TAudio>;
    try {
      promise = Promise.resolve(input.synthesize(item, controller.signal));
    } catch (cause) {
      promise = Promise.reject(cause);
    }
    const pending = { controller, item, promise, settled: false };
    void promise.then(
      () => {
        pending.settled = true;
      },
      () => {
        pending.settled = true;
      },
    );
    void promise.catch(() => undefined);
    return pending;
  };

  return {
    cancel: () => {
      generation += 1;
      if (current !== null && !current.settled) current.controller.abort();
      if (lookahead !== null && !lookahead.settled) lookahead.controller.abort();
      current = null;
      lookahead = null;
      queued = [];
    },
    enqueue: (items) => {
      if (items.length > 0) queued.push(...items);
    },
    playbackFinished: () => {
      current = null;
    },
    playbackStarted: () => {
      if (current === null || lookahead !== null || queued.length === 0) return;
      const item = queued.shift();
      if (item !== undefined) lookahead = begin(item);
    },
    takeNext: async () => {
      if (current !== null) return undefined;
      const pendingLookahead = lookahead;
      lookahead = null;
      const queuedItem = pendingLookahead === null ? queued.shift() : undefined;
      const pending = pendingLookahead ?? (queuedItem === undefined ? null : begin(queuedItem));
      if (pending === null) return undefined;
      current = pending;
      const pendingGeneration = generation;
      try {
        const audio = await pending.promise;
        if (pendingGeneration !== generation || current !== pending) return undefined;
        return { item: pending.item, audio };
      } catch (cause) {
        if (current === pending) current = null;
        throw cause;
      }
    },
  };
}

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
