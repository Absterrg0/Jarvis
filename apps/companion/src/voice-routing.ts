import type { CompanionConversationMode } from "./settings.ts";
import type { CompanionProjectTarget } from "./host.ts";
import {
  canonicalizeProductTerms,
  replaceHeardEntity,
  resolveVoiceLexiconCandidate,
} from "./voice-lexicon.ts";

export type CompanionAttentionTarget = {
  readonly projectId: string;
  readonly threadId: string;
  readonly reportKind?: "completed" | "waiting-for-input" | "approval-needed" | "failed";
};

export type CompanionProjectResolution =
  | {
      readonly kind: "resolved";
      readonly project: CompanionProjectTarget;
      readonly source: "spoken" | "recent" | "only-project";
    }
  | {
      readonly kind: "needs-clarification";
      readonly projects: ReadonlyArray<CompanionProjectTarget>;
    }
  | { readonly kind: "no-projects" };

function normalizedWords(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function projectAliases(project: CompanionProjectTarget): ReadonlyArray<string> {
  const basename = project.workspaceRoot.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
  return [...new Set([normalizedWords(project.title), normalizedWords(basename)])].filter(Boolean);
}

function lexiconProjects(projects: ReadonlyArray<CompanionProjectTarget>) {
  return projects.map((project) => ({
    id: project.id,
    name: project.title,
    aliases: projectAliases(project),
  }));
}

function transcriptNamesProject(transcript: string, alias: string): boolean {
  const words = normalizedWords(transcript);
  if (words === alias || words.startsWith(`${alias} `)) return true;
  return [
    `in ${alias}`,
    `in the ${alias}`,
    `for ${alias}`,
    `for the ${alias}`,
    `inside ${alias}`,
    `within ${alias}`,
    `on ${alias}`,
    `on the ${alias}`,
    `use ${alias}`,
    `switch to ${alias}`,
    `go to ${alias}`,
    `change directory to ${alias}`,
    `project ${alias}`,
    `${alias} project`,
    `${alias} workspace`,
    `${alias} repo`,
  ].some((phrase) => words.includes(phrase));
}

function transcriptHasProjectCue(transcript: string): boolean {
  const words = normalizedWords(transcript);
  return (
    /\b(?:switch to|go to|change directory to) (?:the )?[\p{Letter}\p{Number}]/u.test(words) ||
    /\b(?:project|workspace|repo) [\p{Letter}\p{Number}]/u.test(words) ||
    /\b[\p{Letter}\p{Number}]+ (?:project|workspace|repo)\b/u.test(words)
  );
}

export function companionTranscriptHasProjectCue(transcript: string): boolean {
  return transcriptHasProjectCue(transcript);
}

/** Resolves workspace intent before a provider starts, never by asking the agent to `cd`. */
export function resolveCompanionProjectTarget(input: {
  readonly transcript: string;
  readonly projects: ReadonlyArray<CompanionProjectTarget>;
  readonly recentProjectId?: string;
}): CompanionProjectResolution {
  if (input.projects.length === 0) return { kind: "no-projects" };

  const spokenMatches = input.projects.filter((project) =>
    projectAliases(project).some((alias) => transcriptNamesProject(input.transcript, alias)),
  );
  if (spokenMatches.length === 1) {
    return { kind: "resolved", project: spokenMatches[0]!, source: "spoken" };
  }
  if (spokenMatches.length > 1) {
    return { kind: "needs-clarification", projects: spokenMatches };
  }
  const lexiconMatch = resolveVoiceLexiconCandidate({
    utterance: input.transcript,
    candidates: lexiconProjects(input.projects),
    allowOrdinal: true,
  });
  if (lexiconMatch !== undefined) {
    const project = input.projects.find((candidate) => candidate.id === lexiconMatch.candidateId);
    if (project !== undefined) return { kind: "resolved", project, source: "spoken" };
  }
  if (transcriptHasProjectCue(input.transcript)) {
    return { kind: "needs-clarification", projects: input.projects };
  }
  if (input.projects.length === 1) {
    return { kind: "resolved", project: input.projects[0]!, source: "only-project" };
  }
  const recent = input.projects.find((project) => project.id === input.recentProjectId);
  if (recent !== undefined) return { kind: "resolved", project: recent, source: "recent" };
  return { kind: "needs-clarification", projects: input.projects };
}

export function canonicalizeCompanionTranscript(
  transcript: string,
  projects: ReadonlyArray<CompanionProjectTarget>,
): string {
  const productAware = canonicalizeProductTerms(transcript);
  const match = resolveVoiceLexiconCandidate({
    utterance: productAware,
    candidates: lexiconProjects(projects),
    allowOrdinal: false,
  });
  if (match === undefined) return productAware;
  const project = projects.find((candidate) => candidate.id === match.candidateId);
  return project === undefined
    ? productAware
    : replaceHeardEntity(productAware, match.heard, project.title);
}

/** Explicit worker/provider phrasing starts independent work even in continuation mode. */
export function explicitlyStartsNewCompanionTask(transcript: string): boolean {
  return /\b(?:use|with|through|spin\s+up)\s+(?:the\s+)?(?:codex|claude(?:\s+code)?|cursor|grok|open\s*code)\b/iu.test(
    transcript,
  );
}

/**
 * Referential Director commands need the last thread as context, not as a
 * forced continuation destination. Meaning is still decided by the host.
 */
export function companionContinuationTarget(input: {
  readonly conversationMode: CompanionConversationMode;
  readonly transcript: string;
  readonly attentionTarget?: CompanionAttentionTarget;
}): CompanionAttentionTarget | undefined {
  if (
    input.attentionTarget?.reportKind === "waiting-for-input" ||
    input.attentionTarget?.reportKind === "approval-needed"
  ) {
    return input.attentionTarget;
  }
  return input.conversationMode === "continue-last-thread" &&
    !explicitlyStartsNewCompanionTask(input.transcript) &&
    input.attentionTarget !== undefined
    ? input.attentionTarget
    : undefined;
}
