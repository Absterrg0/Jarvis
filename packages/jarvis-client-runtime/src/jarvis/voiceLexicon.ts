export type VoiceLexiconCandidate = {
  readonly id: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
};

export type VoiceLexiconMatch = {
  readonly candidateId: string;
  readonly confidence: "exact" | "near" | "phonetic" | "ordinal";
  readonly heard: string;
};

export function normalizeVoiceWords(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function soundex(value: string): string {
  const letters = normalizeVoiceWords(value).replace(/[^a-z]/gu, "");
  if (letters.length === 0) return "";
  const groups: Readonly<Record<string, string>> = {
    b: "1",
    f: "1",
    p: "1",
    v: "1",
    c: "2",
    g: "2",
    j: "2",
    k: "2",
    q: "2",
    s: "2",
    x: "2",
    z: "2",
    d: "3",
    t: "3",
    l: "4",
    m: "5",
    n: "5",
    r: "6",
  };
  const first = letters[0]!.toUpperCase();
  let previous = groups[letters[0]!] ?? "";
  let encoded = "";
  for (const letter of letters.slice(1)) {
    const next = groups[letter] ?? "";
    if (next.length > 0 && next !== previous) encoded += next;
    previous = next;
  }
  return `${first}${encoded}000`.slice(0, 4);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const next = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      next.push(
        Math.min(
          next[rightIndex]! + 1,
          previous[rightIndex + 1]! + 1,
          previous[rightIndex]! + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    previous = next;
  }
  return previous[right.length]!;
}

function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - editDistance(left, right) / longest;
}

function ordinalIndex(words: string): number | undefined {
  const tokens = words.split(" ");
  const explicit: ReadonlyArray<readonly [string, number]> = [
    ["first", 0],
    ["1st", 0],
    ["second", 1],
    ["2nd", 1],
    ["other", 1],
    ["third", 2],
    ["3rd", 2],
    ["fourth", 3],
    ["4th", 3],
  ];
  const explicitMatch = explicit.find(([word]) => tokens.includes(word));
  if (explicitMatch !== undefined) return explicitMatch[1];
  const cardinal: ReadonlyArray<readonly [string, number]> = [
    ["one", 0],
    ["1", 0],
    ["two", 1],
    ["2", 1],
    ["three", 2],
    ["3", 2],
    ["four", 3],
    ["4", 3],
  ];
  return cardinal.find(([word]) => tokens.includes(word))?.[1];
}

function likelyEntityWords(utterance: string): ReadonlyArray<string> {
  const words = normalizeVoiceWords(utterance);
  const cue =
    /\b(?:in|for|inside|within|on|use|switch to|go to|change directory to|check out|project|workspace|repo)(?: the)? (.+)$/u.exec(
      words,
    );
  const relevant = cue?.[1] ?? (words.split(" ").length <= 4 ? words : "");
  const tokens = relevant.split(" ").filter(Boolean);
  return [
    ...new Set(
      tokens.flatMap((_, index) =>
        Array.from({ length: Math.min(4, tokens.length - index) }, (_unused, offset) =>
          tokens.slice(index, index + offset + 1).join(" "),
        ),
      ),
    ),
  ];
}

/** Matches only against real entities and requires a clear phonetic winner. */
export function resolveVoiceLexiconCandidate(input: {
  readonly utterance: string;
  readonly candidates: ReadonlyArray<VoiceLexiconCandidate>;
  readonly allowOrdinal?: boolean;
}): VoiceLexiconMatch | undefined {
  const utterance = normalizeVoiceWords(input.utterance);
  if (input.allowOrdinal) {
    const index = ordinalIndex(utterance);
    const candidate = index === undefined ? undefined : input.candidates[index];
    if (candidate !== undefined) {
      return { candidateId: candidate.id, confidence: "ordinal", heard: utterance };
    }
  }

  const exact = input.candidates.flatMap((candidate) =>
    candidate.aliases
      .map(normalizeVoiceWords)
      .filter(Boolean)
      .filter(
        (alias) =>
          utterance === alias ||
          utterance.startsWith(`${alias} `) ||
          utterance.endsWith(` ${alias}`) ||
          utterance.includes(` ${alias} `),
      )
      .map((heard) => ({ candidateId: candidate.id, confidence: "exact" as const, heard })),
  );
  const exactCandidateIds = new Set(exact.map(({ candidateId }) => candidateId));
  if (exactCandidateIds.size === 1) return exact[0];
  if (exactCandidateIds.size > 1) return undefined;

  const heardValues = likelyEntityWords(input.utterance);
  const ranked = input.candidates
    .map((candidate) => {
      const aliases = candidate.aliases.map(normalizeVoiceWords).filter(Boolean);
      const scores = heardValues.flatMap((heard) =>
        aliases.map((alias) => {
          const spelling = similarity(heard, alias);
          const heardSound = soundex(heard);
          const aliasSound = soundex(alias);
          const phonetic =
            heardSound.length > 0 && aliasSound.length > 0 ? similarity(heardSound, aliasSound) : 0;
          return {
            heard,
            score: Math.max(spelling, phonetic * 0.92),
            confidence: spelling >= 0.8 ? ("near" as const) : ("phonetic" as const),
          };
        }),
      );
      return {
        candidate,
        ...(scores.toSorted((left, right) =>
          right.score === left.score
            ? right.heard.split(" ").length - left.heard.split(" ").length
            : right.score - left.score,
        )[0] ?? { heard: "", score: 0, confidence: "phonetic" as const }),
      };
    })
    .toSorted((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best === undefined || best.score < 0.68 || best.score - (runnerUp?.score ?? 0) < 0.18) {
    return undefined;
  }
  return {
    candidateId: best.candidate.id,
    confidence: best.confidence,
    heard: best.heard,
  };
}

export function replaceHeardEntity(
  utterance: string,
  heard: string,
  canonicalName: string,
): string {
  if (heard.length === 0) return utterance;
  const pattern = new RegExp(`\\b${heard.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu");
  return utterance.replace(pattern, canonicalName);
}

export function canonicalizeProductTerms(utterance: string): string {
  return utterance
    .replace(/\b(?:get\s+hub|git\s+hub)\b/giu, "GitHub")
    .replace(/\bopen\s+code\b/giu, "OpenCode");
}

export function resolveVoiceConfirmation(utterance: string): "accept" | "decline" | undefined {
  const normalized = normalizeVoiceWords(utterance);
  if (/\b(?:no|decline|wrong|cancel|not that)\b/u.test(normalized)) return "decline";
  if (/\b(?:yes|correct|right|accept|go ahead|proceed|that one)\b/u.test(normalized)) {
    return "accept";
  }
  return undefined;
}
