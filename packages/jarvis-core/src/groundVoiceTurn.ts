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

function inferredMention(utterance: string): ProjectMention | undefined {
  const pullRequestMatch =
    /\bcheck out\s+(?:if|whether)\s+there\s+(?:is|are)\s+(?:any\s+)?(?:pull\s+requests?|prs?)\s+(?:in|for|on)\s+(?:the\s+)?(.+?)(?=\s*[.!?]*$)/iu.exec(
      utterance.trim(),
    );
  const generalMatch =
    /\b(?:check out|look at|inspect|review|open|work on)\s+(?:the\s+)?(.+?)(?:\s+(?:project|workspace|repo|repository))?(?=\s*(?:,|\b(?:and|then|also)\s+(?:add|build|change|create|delete|deploy|edit|fix|implement|install|merge|move|push|remove|rename|replace|rewrite|update|write)\b|[.!?]*$))/iu.exec(
      utterance.trim(),
    );
  const match = pullRequestMatch ?? generalMatch;
  const captured = match?.[1];
  const heard = captured?.trim();
  if (match === null || captured === undefined || heard === undefined || heard.length === 0) {
    return undefined;
  }
  if (
    match === generalMatch &&
    /^(?:branch|tag|commit|pull request|pr|file|issue)\b/iu.test(heard)
  ) {
    return undefined;
  }
  const relativeStart = match[0].indexOf(captured);
  const start = match.index + relativeStart;
  return { heard, start, end: start + heard.length, explicit: false };
}

function projectMention(
  utterance: string,
  mode: "explicit-only" | "explicit-or-inferred",
): ProjectMention | undefined {
  return (
    explicitSuffixMention(utterance) ??
    explicitPrefixMention(utterance) ??
    (mode === "explicit-or-inferred" ? inferredMention(utterance) : undefined)
  );
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
  const mention = projectMention(sourceUtterance, input.mode ?? "explicit-or-inferred");
  if (mention === undefined) {
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
        heard: mention.heard,
        prompt: "That project is no longer available. Which project did you mean?",
        candidates: labels(input.candidates),
      };
    }
    return {
      status: "resolved",
      sourceUtterance,
      utterance: canonicalizeMention(sourceUtterance, mention, confirmed.title),
      heard: mention.heard,
      match: "confirmed-pronunciation",
      project: confirmed.project,
    };
  }

  const query = normalize(mention.heard);
  const exact = input.candidates.filter((candidate) =>
    candidate.names.some((name) => normalize(name) === query),
  );
  if (exact.length === 1) {
    const candidate = exact[0];
    if (candidate === undefined) {
      return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
    }
    return {
      status: "resolved",
      sourceUtterance,
      utterance: canonicalizeMention(sourceUtterance, mention, candidate.title),
      heard: mention.heard,
      match: candidate.title === mention.heard ? "exact" : "confirmed-pronunciation",
      project: candidate.project,
    };
  }
  if (exact.length > 1) {
    return {
      status: "needs-clarification",
      sourceUtterance,
      heard: mention.heard,
      prompt: `More than one project matches “${mention.heard}”. Which one did you mean?`,
      candidates: labels(exact),
    };
  }

  const ranked = input.candidates
    .map((candidate) => {
      const scores = candidate.names.map((name) => {
        const normalizedName = normalize(name);
        const spelling = similarity(query, normalizedName);
        const querySound = soundex(query);
        const nameSound = soundex(normalizedName);
        const phonetic =
          querySound.length > 0 && nameSound.length > 0
            ? similarity(querySound, nameSound) * 0.92
            : 0;
        return { score: Math.max(spelling, phonetic), spelling };
      });
      const best = scores.sort((left, right) => right.score - left.score)[0] ?? {
        score: 0,
        spelling: 0,
      };
      return { candidate, ...best };
    })
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  const margin = best === undefined ? 0 : best.score - (runnerUp?.score ?? 0);
  if (best !== undefined && best.spelling >= 0.8 && margin >= 0.15) {
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
  if (plausibleTies.length > 1) {
    return {
      status: "needs-clarification",
      sourceUtterance,
      heard: mention.heard,
      prompt: `More than one project sounds like “${mention.heard}”. Which one did you mean?`,
      candidates: labels(
        plausibleTies.map(({ candidate }) => candidate),
        mention.heard,
      ),
    };
  }
  if (best !== undefined && best.score >= 0.68 && margin >= 0.18) {
    return {
      status: "needs-confirmation",
      sourceUtterance,
      heard: mention.heard,
      prompt: `Did you mean ${best.candidate.title}?`,
      project: best.candidate.project,
    };
  }
  if (mention.explicit) {
    return {
      status: "needs-clarification",
      sourceUtterance,
      heard: mention.heard,
      prompt: `I couldn't match “${mention.heard}” to a Jarvis project.`,
      candidates: labels(input.candidates),
    };
  }
  return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
}
