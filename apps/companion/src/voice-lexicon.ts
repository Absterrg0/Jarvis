export type VoiceLexiconCandidate = {
  readonly id: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
};

export type VoiceLexiconMatch = {
  readonly candidateId: string;
  readonly confidence: "exact" | "phonetic" | "ordinal";
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
    /\b(?:in|for|inside|within|on|use|switch to|go to|change directory to|project|workspace|repo)(?: the)? (.+)$/u.exec(
      words,
    );
  const relevant = cue?.[1] ?? (words.split(" ").length <= 4 ? words : "");
  const tokens = relevant.split(" ").filter(Boolean);
  return [
    ...new Set(
      tokens.flatMap((_, index) => [tokens[index]!, tokens.slice(index, index + 2).join(" ")]),
    ),
  ];
}

/**
 * Resolves only against a closed set of real entities. Phonetic recovery is
 * accepted only with a clear winning margin, so a guessed name can never
 * silently route work to an unrelated project.
 */
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

  for (const candidate of input.candidates) {
    for (const alias of candidate.aliases.map(normalizeVoiceWords).filter(Boolean)) {
      if (
        utterance === alias ||
        utterance.includes(` ${alias}`) ||
        utterance.startsWith(`${alias} `)
      ) {
        return { candidateId: candidate.id, confidence: "exact", heard: alias };
      }
    }
  }

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
          return { heard, score: Math.max(spelling, phonetic * 0.92) };
        }),
      );
      return {
        candidate,
        ...(scores.toSorted((left, right) => right.score - left.score)[0] ?? {
          heard: "",
          score: 0,
        }),
      };
    })
    .toSorted((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best === undefined || best.score < 0.68 || best.score - (runnerUp?.score ?? 0) < 0.18) {
    return undefined;
  }
  return { candidateId: best.candidate.id, confidence: "phonetic", heard: best.heard };
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

/** A deliberately small global vocabulary; dynamic project names stay candidate-scoped. */
export function canonicalizeProductTerms(utterance: string): string {
  return utterance
    .replace(/\b(?:get\s+hub|git\s+hub)\b/giu, "GitHub")
    .replace(/\bopen\s+code\b/giu, "OpenCode");
}
