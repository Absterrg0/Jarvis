import type { JarvisProjectAlias, OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

export type ProjectTargetResolution =
  | { readonly status: "not-requested" }
  | {
      readonly status: "resolved";
      readonly projectId: ProjectId;
      readonly correctedUtterance?: string;
    }
  | {
      readonly status: "needs-input";
      readonly prompt: string;
      readonly choices: ReadonlyArray<string>;
      readonly candidates: ReadonlyArray<{
        readonly projectId: ProjectId;
        readonly label: string;
        readonly learnedAlias?: string;
      }>;
    };

const normalized = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) ?? path
  );
}

function soundex(value: string): string {
  const letters = normalized(value).replace(/[^a-z]/gu, "");
  if (letters.length === 0) return "";
  const groups: Record<string, string> = {
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
  let previous = groups[letters[0]!] ?? "";
  let code = letters[0]!.toUpperCase();
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

function names(
  project: OrchestrationProjectShell,
  aliases: ReadonlyArray<JarvisProjectAlias>,
): ReadonlyArray<string> {
  return [
    project.title,
    basename(project.workspaceRoot),
    project.repositoryIdentity?.displayName,
    project.repositoryIdentity?.name,
    ...aliases.filter((alias) => alias.projectId === project.id).map((alias) => alias.alias),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function candidateLabels(projects: ReadonlyArray<OrchestrationProjectShell>) {
  const titles = projects.map((project) => project.title);
  const base = projects.map((project, index) =>
    titles.filter((title) => title === titles[index]).length > 1
      ? `${project.title} — ${basename(project.workspaceRoot)}`
      : project.title,
  );
  return projects.map((project, index) => ({
    projectId: project.id,
    label:
      base.filter((label) => label === base[index]).length > 1
        ? `${base[index]} (${index + 1})`
        : base[index]!,
  }));
}

function needsInput(
  prompt: string,
  projects: ReadonlyArray<OrchestrationProjectShell>,
  learnedAlias?: string,
): ProjectTargetResolution {
  const candidates = candidateLabels(projects.slice(0, 5)).map((candidate) => ({
    ...candidate,
    ...(learnedAlias === undefined ? {} : { learnedAlias }),
  }));
  return {
    status: "needs-input",
    prompt,
    choices: candidates.map(({ label }) => label),
    candidates,
  };
}

function inferredSpokenTarget(utterance: string): string | undefined {
  const match =
    /\b(?:check out|look at|inspect|review|open|work on)\s+(?:the\s+)?(.+?)(?:\s+(?:project|workspace|repo|repository))?(?=\s*(?:,|\b(?:and|then|also)\s+(?:add|build|change|create|delete|deploy|edit|fix|implement|install|merge|move|push|remove|rename|replace|rewrite|update|write)\b|[.!?]*$))/iu.exec(
      utterance.trim(),
    );
  const spoken = match?.[1]?.trim();
  return spoken === undefined || spoken.length === 0 ? undefined : spoken;
}

function replaceSpokenTarget(utterance: string, spoken: string, title: string): string {
  const escaped = spoken.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return utterance.replace(new RegExp(escaped, "iu"), title);
}

function resolveInferredTarget(input: {
  readonly utterance: string;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly aliases: ReadonlyArray<JarvisProjectAlias>;
}): ProjectTargetResolution {
  const spoken = inferredSpokenTarget(input.utterance);
  if (spoken === undefined) return { status: "not-requested" };
  const query = normalized(spoken);
  const exact = input.projects.filter((project) =>
    names(project, input.aliases).some((name) => normalized(name) === query),
  );
  if (exact.length === 1) {
    const project = exact[0]!;
    return {
      status: "resolved",
      projectId: project.id,
      correctedUtterance: replaceSpokenTarget(input.utterance, spoken, project.title),
    };
  }
  if (exact.length > 1) {
    return needsInput(`More than one project matches “${spoken}”. Which one did you mean?`, exact);
  }

  const ranked = input.projects
    .map((project) => ({
      project,
      score: Math.max(
        ...names(project, input.aliases).map((name) => similarity(query, normalized(name))),
      ),
    }))
    .toSorted((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best !== undefined && best.score >= 0.8 && best.score - (runnerUp?.score ?? 0) >= 0.15) {
    return {
      status: "resolved",
      projectId: best.project.id,
      correctedUtterance: replaceSpokenTarget(input.utterance, spoken, best.project.title),
    };
  }

  const querySound = soundex(query);
  const phonetic = input.projects.filter((project) =>
    names(project, input.aliases).some((name) => {
      const candidateSound = soundex(name);
      return (
        querySound.length > 0 &&
        candidateSound.length > 0 &&
        similarity(querySound, candidateSound) >= 0.75
      );
    }),
  );
  if (phonetic.length === 1) {
    return needsInput(`Did you mean ${phonetic[0]!.title}?`, phonetic, query);
  }
  if (phonetic.length > 1) {
    return needsInput(
      `More than one project sounds like “${spoken}”. Which one did you mean?`,
      phonetic,
      query,
    );
  }
  return { status: "not-requested" };
}

export function resolveProjectTarget(input: {
  readonly utterance: string;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly aliases?: ReadonlyArray<JarvisProjectAlias>;
  readonly inferNamedTarget?: boolean;
}): ProjectTargetResolution {
  const aliases = input.aliases ?? [];
  const suffixes = [...input.utterance.matchAll(/\s+(?:project|workspace|repo|repository)\b/giu)];
  const suffix = suffixes.at(-1);
  const beforeSuffix = suffix === undefined ? "" : input.utterance.slice(0, suffix.index);
  const preposition = /\b(?:to|in|inside|within|on|into)\s+(?:the\s+)?/giu;
  const boundaries = [...beforeSuffix.matchAll(preposition)];
  const lastBoundary = boundaries.at(-1);
  const spoken =
    lastBoundary === undefined
      ? undefined
      : beforeSuffix.slice(lastBoundary.index + lastBoundary[0].length).trim();
  if (spoken === undefined) {
    return input.inferNamedTarget
      ? resolveInferredTarget({ utterance: input.utterance, projects: input.projects, aliases })
      : { status: "not-requested" };
  }
  const query = normalized(spoken);
  const exact = input.projects.filter((project) =>
    names(project, aliases).some((name) => normalized(name) === query),
  );
  if (exact.length === 1) return { status: "resolved", projectId: exact[0]!.id };
  if (exact.length > 1) {
    return needsInput(`More than one project is named “${spoken}”. Which one did you mean?`, exact);
  }
  const phonetic = query.includes(" ")
    ? []
    : input.projects.filter((project) =>
        names(project, aliases).some((name) => {
          const candidate = normalized(name);
          return !candidate.includes(" ") && soundex(candidate) === soundex(query);
        }),
      );
  if (phonetic.length === 0) {
    return needsInput(`I couldn't match “${spoken}” to a T3 project.`, input.projects);
  }
  return needsInput(
    phonetic.length === 1
      ? `Did you mean ${phonetic[0]!.title}?`
      : `More than one project sounds like “${spoken}”. Which one did you mean?`,
    phonetic,
    query,
  );
}
