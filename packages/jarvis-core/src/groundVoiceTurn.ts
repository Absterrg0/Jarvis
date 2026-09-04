export interface VoiceProjectCandidate<Project> {
  readonly id: string;
  readonly title: string;
  readonly label?: string;
  readonly names: ReadonlyArray<string>;
  readonly project: Project;
}

export type VoiceProjectMatchKind = "exact" | "near" | "confirmed-pronunciation";

export type GroundedVoiceTurn<Project> =
  | {
      readonly status: "not-mentioned";
      readonly sourceUtterance: string;
      readonly utterance: string;
    }
  | {
      readonly status: "resolved";
      readonly sourceUtterance: string;
      readonly utterance: string;
      readonly heard: string;
      readonly match: VoiceProjectMatchKind;
      readonly project: Project;
    }
  | {
      readonly status: "needs-confirmation";
      readonly sourceUtterance: string;
      readonly heard: string;
      readonly prompt: string;
      readonly project: Project;
    }
  | {
      readonly status: "needs-clarification";
      readonly sourceUtterance: string;
      readonly heard: string;
      readonly prompt: string;
      readonly candidates: ReadonlyArray<{
        readonly project: Project;
        readonly label: string;
        readonly learnedAlias?: string;
      }>;
    };

type ProjectMention = {
  readonly heard: string;
  readonly start: number;
  readonly end: number;
  readonly explicit: boolean;
};

/**
 * Tokens that mark version-control references rather than project mentions.
 * A candidate span touching one of these is skipped, so "checkout zivil" or
 * "the Rivvl branch" never fuzzy-match a project the user did not name.
 */
const TASK_DOMAIN_TOKENS: ReadonlySet<string> = new Set([
  "branch",
  "tag",
  "commit",
  "pull",
  "request",
  "pr",
  "prs",
  "file",
  "files",
  "issue",
  "issues",
  "checkout",
  "switch",
  "merge",
  "rebase",
  "clone",
  "fetch",
]);

type WordToken = { readonly word: string; readonly start: number; readonly end: number };

function wordTokens(utterance: string): WordToken[] {
  const tokens: WordToken[] = [];
  const pattern = /[\p{Letter}\p{Number}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(utterance)) !== null) {
    tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function scoreSpanText(span: string, name: string): { score: number; spelling: number } {
  if (span === name) return { score: 1, spelling: 1 };
  const spelling = similarity(span, name);
  const spanSound = soundex(span);
  const nameSound = soundex(name);
  const phonetic =
    spanSound.length > 0 && nameSound.length > 0 ? similarity(spanSound, nameSound) * 0.92 : 0;
  return { score: Math.max(spelling, phonetic), spelling };
}

type SpanHit = {
  readonly score: number;
  readonly spelling: number;
  readonly start: number;
  readonly end: number;
  readonly heard: string;
};

/**
 * Match-first mention detection: score every token window against every
 * catalog name instead of extracting a mention with verb/preposition
 * patterns first. Detection falls out of matching, so new phrasings like
 * "check the authentication in Rebel" work without another pattern.
 */
function scanSpans(
  utterance: string,
  words: ReadonlyArray<WordToken>,
  normalizedWords: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
  fuzzy: boolean,
  maxWindow: number,
): SpanHit | undefined {
  let best: SpanHit | undefined;
  const consider = (
    score: number,
    spelling: number,
    start: number,
    end: number,
    heard: string,
  ): void => {
    if (best === undefined || score > best.score) {
      best = { score, spelling, start, end, heard };
    }
  };
  for (let start = 0; start < words.length; start += 1) {
    for (let length = 1; length <= maxWindow && start + length <= words.length; length += 1) {
      const before = normalizedWords[start - 1];
      const after = normalizedWords[start + length];
      if (
        (before !== undefined && TASK_DOMAIN_TOKENS.has(before)) ||
        (after !== undefined && TASK_DOMAIN_TOKENS.has(after))
      ) {
        continue;
      }
      const first = words[start];
      const last = words[start + length - 1];
      if (first === undefined || last === undefined) continue;
      const heard = utterance.slice(first.start, last.end).trim();
      if (heard.length === 0) continue;
      const span = normalizedWords.slice(start, start + length).join(" ");
      for (const name of names) {
        const normalizedName = normalize(name);
        if (normalizedName.length === 0) continue;
        if (span === normalizedName) {
          consider(1, 1, first.start, last.end, heard);
        } else if (fuzzy) {
          const { score, spelling } = scoreSpanText(span, normalizedName);
          consider(score, spelling, first.start, last.end, heard);
        }
      }
    }
  }
  return best;
}

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");

function soundex(value: string): string {
  const letters = normalize(value).replace(/[^a-z]/gu, "");
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
  const firstLetter = letters.charAt(0);
  let previous = groups[firstLetter] ?? "";
  let code = firstLetter.toUpperCase();
  for (const letter of letters.slice(1)) {
    const digit = groups[letter] ?? "";
    if (digit !== "" && digit !== previous) code += digit;
    previous = digit;
  }
  return `${code}000`.slice(0, 4);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const next = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const insertion = next[rightIndex] ?? leftIndex + rightIndex + 1;
      const deletion = previous[rightIndex + 1] ?? leftIndex + rightIndex + 2;
      const substitution = previous[rightIndex] ?? leftIndex + rightIndex;
      next.push(
        Math.min(
          insertion + 1,
          deletion + 1,
          substitution + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    previous = next;
  }
  return previous[right.length] ?? 0;
}

function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - editDistance(left, right) / longest;
}

function explicitSuffixMention(utterance: string): ProjectMention | undefined {
  const suffixes = [...utterance.matchAll(/\s+(?:project|workspace|repo|repository)\b/giu)];
  const suffix = suffixes.at(-1);
  if (suffix === undefined) return undefined;
  const beforeSuffix = utterance.slice(0, suffix.index);
  const boundaries = [
    ...beforeSuffix.matchAll(/\b(?:to|in|inside|within|on|into)\s+(?:the\s+)?/giu),
  ];
  const boundary = boundaries.at(-1);
  if (boundary === undefined) return undefined;
  const start = boundary.index + boundary[0].length;
  const heard = beforeSuffix.slice(start).trim();
  return heard.length === 0
    ? undefined
    : { heard, start, end: start + heard.length, explicit: true };
}

function explicitPrefixMention(utterance: string): ProjectMention | undefined {
  const match =
    /\b(?:in|inside|within|on)\s+(?:the\s+)?([^,;.!?]+?)(?:\s+(?:project|workspace|repo|repository))?(?=\s*[,;]|\s+(?:please\s+)?(?:check|look|inspect|review|open|work|add|build|change|create|delete|deploy|edit|fix|implement|install|merge|move|push|remove|rename|replace|rewrite|update|write)\b)/iu.exec(
      utterance,
    );
  const captured = match?.[1];
  const heard = captured?.trim();
  if (match === null || captured === undefined || heard === undefined || heard.length === 0) {
    return undefined;
  }
  const relativeStart = match[0].indexOf(captured);
  const start = match.index + relativeStart;
  return { heard, start, end: start + heard.length, explicit: true };
}

/**
 * Explicit project-slot syntax ("in X", "X project") with its span. Used
 * only as the fallback signal for "couldn't match": detection itself now
 * falls out of span scoring above.
 */
function explicitProjectMention(utterance: string): ProjectMention | undefined {
  return explicitSuffixMention(utterance) ?? explicitPrefixMention(utterance);
}

function canonicalizeMention(utterance: string, mention: ProjectMention, title: string): string {
  return `${utterance.slice(0, mention.start)}${title}${utterance.slice(mention.end)}`;
}

function labels<Project>(
  candidates: ReadonlyArray<VoiceProjectCandidate<Project>>,
  learnedAlias?: string,
) {
  const duplicateTitles = new Set(
    candidates
      .map(({ title }) => title)
      .filter((title, index, titles) => titles.indexOf(title) !== index),
  );
  const bounded = candidates.slice(0, 5);
  const baseLabels = bounded.map((candidate) =>
    duplicateTitles.has(candidate.title) && candidate.label !== undefined
      ? candidate.label
      : candidate.title,
  );
  const occurrences = new Map<string, number>();
  return bounded.map((candidate) => {
    const baseLabel =
      duplicateTitles.has(candidate.title) && candidate.label !== undefined
        ? candidate.label
        : candidate.title;
    const occurrence = (occurrences.get(baseLabel) ?? 0) + 1;
    occurrences.set(baseLabel, occurrence);
    return {
      project: candidate.project,
      label:
        baseLabels.filter((label) => label === baseLabel).length > 1
          ? `${baseLabel} (${occurrence})`
          : baseLabel,
      ...(learnedAlias === undefined ? {} : { learnedAlias }),
    };
  });
}

/**
 * Grounds a spoken project slot against a bounded catalog. A resolved result
 * owns both the route and the canonical utterance; raw ASR text is retained
 * only as source evidence.
 */
export function groundVoiceTurn<Project>(input: {
  readonly utterance: string;
  readonly candidates: ReadonlyArray<VoiceProjectCandidate<Project>>;
  readonly mode?: "explicit-only" | "explicit-or-inferred";
  readonly confirmedCandidateId?: string;
}): GroundedVoiceTurn<Project> {
  const sourceUtterance = input.utterance.trim();
  const fuzzy = (input.mode ?? "explicit-or-inferred") !== "explicit-only";
  const words = wordTokens(sourceUtterance);
  const normalizedWords = words.map((token) => normalize(token.word));
  // Mishearings can run longer than the name ("alert effect" for
  // "Alertify"), so windows extend past the longest catalog name.
  const maxWindow = Math.max(
    4,
    ...input.candidates.flatMap((candidate) =>
      candidate.names.map((name) => normalize(name).split(" ").length),
    ),
  );

  type RankedHit = {
    readonly candidate: VoiceProjectCandidate<Project>;
    readonly score: number;
    readonly spelling: number;
    readonly start: number;
    readonly end: number;
    readonly heard: string;
  };
  const ranked: RankedHit[] = [];
  for (const candidate of input.candidates) {
    let best: Omit<RankedHit, "candidate"> | undefined;
    const consider = (
      score: number,
      spelling: number,
      start: number,
      end: number,
      heard: string,
    ): void => {
      if (
        best === undefined ||
        score > best.score ||
        (score === best.score && heard.length > best.heard.length)
      ) {
        best = { score, spelling, start, end, heard };
      }
    };
    for (const name of candidate.names) {
      const normalizedName = normalize(name);
      if (normalizedName.length === 0) continue;
      for (let start = 0; start < words.length; start += 1) {
        for (let length = 1; length <= maxWindow && start + length <= words.length; length += 1) {
          const before = normalizedWords[start - 1];
          const after = normalizedWords[start + length];
          if (
            (before !== undefined && TASK_DOMAIN_TOKENS.has(before)) ||
            (after !== undefined && TASK_DOMAIN_TOKENS.has(after))
          ) {
            continue;
          }
          const first = words[start];
          const last = words[start + length - 1];
          if (first === undefined || last === undefined) continue;
          const heard = sourceUtterance.slice(first.start, last.end).trim();
          if (heard.length === 0) continue;
          const span = normalizedWords.slice(start, start + length).join(" ");
          if (span === normalizedName) {
            consider(1, 1, first.start, last.end, heard);
          } else if (fuzzy) {
            const { score, spelling } = scoreSpanText(span, normalizedName);
            consider(score, spelling, first.start, last.end, heard);
          }
        }
      }
    }
    if (best !== undefined) ranked.push({ candidate, ...best });
  }
  ranked.sort((left, right) => right.score - left.score);

  const mentionOf = (hit: RankedHit): ProjectMention => ({
    heard: hit.heard,
    start: hit.start,
    end: hit.end,
    explicit: false,
  });

  if (ranked.length === 0) {
    return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
  }

  if (input.confirmedCandidateId !== undefined) {
    const confirmed = input.candidates.find(
      (candidate) => candidate.id === input.confirmedCandidateId,
    );
    if (confirmed === undefined) {
      return {
        status: "needs-clarification",
        sourceUtterance,
        heard: ranked[0]?.heard ?? sourceUtterance,
        prompt: "That project is no longer available. Which project did you mean?",
        candidates: labels(input.candidates),
      };
    }
    const top = ranked[0];
    if (top === undefined) {
      return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
    }
    return {
      status: "resolved",
      sourceUtterance,
      utterance: canonicalizeMention(sourceUtterance, mentionOf(top), confirmed.title),
      heard: top.heard,
      match: "confirmed-pronunciation",
      project: confirmed.project,
    };
  }

  const exact = ranked.filter((hit) => hit.score === 1);
  if (exact.length === 1) {
    const hit = exact[0];
    if (hit === undefined) {
      return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
    }
    const mention = mentionOf(hit);
    return {
      status: "resolved",
      sourceUtterance,
      utterance: canonicalizeMention(sourceUtterance, mention, hit.candidate.title),
      heard: mention.heard,
      match: hit.candidate.title === mention.heard ? "exact" : "confirmed-pronunciation",
      project: hit.candidate.project,
    };
  }
  if (exact.length > 1) {
    const earliest = [...exact].sort((left, right) => left.start - right.start)[0];
    const heard = earliest === undefined ? sourceUtterance : earliest.heard;
    return {
      status: "needs-clarification",
      sourceUtterance,
      heard,
      prompt: `More than one project matches “${heard}”. Which one did you mean?`,
      candidates: labels(exact.map(({ candidate }) => candidate)),
    };
  }

  const best = ranked[0];
  const runnerUp = ranked[1];
  const margin = best === undefined ? 0 : best.score - (runnerUp?.score ?? 0);
  if (best !== undefined && best.spelling >= 0.8 && margin >= 0.15) {
    const mention = mentionOf(best);
    return {
      status: "resolved",
      sourceUtterance,
      utterance: canonicalizeMention(sourceUtterance, mention, best.candidate.title),
      heard: mention.heard,
      match: "near",
      project: best.candidate.project,
    };
  }
  const plausibleTies =
    best === undefined
      ? []
      : ranked.filter(({ score }) => score >= 0.68 && best.score - score < 0.18);
  if (plausibleTies.length > 1 && best !== undefined) {
    return {
      status: "needs-clarification",
      sourceUtterance,
      heard: best.heard,
      prompt: `More than one project sounds like “${best.heard}”. Which one did you mean?`,
      candidates: labels(
        plausibleTies.map(({ candidate }) => candidate),
        best.heard,
      ),
    };
  }
  if (best !== undefined && best.score >= 0.68 && margin >= 0.18) {
    return {
      status: "needs-confirmation",
      sourceUtterance,
      heard: best.heard,
      prompt: `Did you mean ${best.candidate.title}?`,
      project: best.candidate.project,
    };
  }
  const explicitSpan = explicitProjectMention(sourceUtterance);
  if (explicitSpan !== undefined) {
    return {
      status: "needs-clarification",
      sourceUtterance,
      heard: explicitSpan.heard,
      prompt: `I couldn't match “${explicitSpan.heard}” to a Jarvis project.`,
      candidates: labels(input.candidates),
    };
  }
  return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
}
