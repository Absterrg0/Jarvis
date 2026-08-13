import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

export type ProjectTargetResolution =
  | { readonly status: "not-requested" }
  | { readonly status: "resolved"; readonly projectId: ProjectId }
  | {
      readonly status: "needs-input";
      readonly prompt: string;
      readonly choices: ReadonlyArray<string>;
      readonly candidates: ReadonlyArray<{ readonly projectId: ProjectId; readonly label: string }>;
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

function names(project: OrchestrationProjectShell): ReadonlyArray<string> {
  return [
    project.title,
    basename(project.workspaceRoot),
    project.repositoryIdentity?.displayName,
    project.repositoryIdentity?.name,
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
): ProjectTargetResolution {
  const candidates = candidateLabels(projects.slice(0, 5));
  return {
    status: "needs-input",
    prompt,
    choices: candidates.map(({ label }) => label),
    candidates,
  };
}

export function resolveProjectTarget(input: {
  readonly utterance: string;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
}): ProjectTargetResolution {
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
  if (spoken === undefined) return { status: "not-requested" };
  const query = normalized(spoken);
  const exact = input.projects.filter((project) =>
    names(project).some((name) => normalized(name) === query),
  );
  if (exact.length === 1) return { status: "resolved", projectId: exact[0]!.id };
  if (exact.length > 1) {
    return needsInput(`More than one project is named “${spoken}”. Which one did you mean?`, exact);
  }
  const phonetic = query.includes(" ")
    ? []
    : input.projects.filter((project) =>
        names(project).some((name) => {
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
  );
}
