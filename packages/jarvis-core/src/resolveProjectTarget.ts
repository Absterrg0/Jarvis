import type { JarvisProjectAlias, OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import { groundVoiceTurn, type VoiceProjectCandidate } from "./groundVoiceTurn.ts";

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

function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) ?? path
  );
}

function projectCandidates(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  aliases: ReadonlyArray<JarvisProjectAlias>,
): ReadonlyArray<VoiceProjectCandidate<OrchestrationProjectShell>> {
  return projects.map((project) => ({
    id: project.id,
    title: project.title,
    label: `${project.title} — ${basename(project.workspaceRoot)}`,
    names: [
      project.title,
      basename(project.workspaceRoot),
      project.repositoryIdentity?.displayName,
      project.repositoryIdentity?.name,
      ...aliases.filter((alias) => alias.projectId === project.id).map((alias) => alias.alias),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    project,
  }));
}

/**
 * Adapts the shared grounder to one selected Host's local project catalog.
 * Cross-node clients ground with qualified candidate IDs before routing; the
 * authenticated Host boundary then validates only its own ProjectIds here.
 */
export function resolveProjectTarget(input: {
  readonly utterance: string;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly aliases?: ReadonlyArray<JarvisProjectAlias>;
  readonly inferNamedTarget?: boolean;
  readonly confirmedProjectId?: ProjectId;
}): ProjectTargetResolution {
  const grounded = groundVoiceTurn({
    utterance: input.utterance,
    candidates: projectCandidates(input.projects, input.aliases ?? []),
    mode: input.inferNamedTarget === true ? "explicit-or-inferred" : "explicit-only",
    ...(input.confirmedProjectId === undefined
      ? {}
      : { confirmedCandidateId: input.confirmedProjectId }),
  });
  if (grounded.status === "not-mentioned") return { status: "not-requested" };
  if (grounded.status === "resolved") {
    return {
      status: "resolved",
      projectId: grounded.project.id,
      ...(grounded.utterance === grounded.sourceUtterance
        ? {}
        : { correctedUtterance: grounded.utterance }),
    };
  }
  if (grounded.status === "needs-confirmation") {
    return {
      status: "needs-input",
      prompt: grounded.prompt,
      choices: [grounded.project.title],
      candidates: [
        {
          projectId: grounded.project.id,
          label: grounded.project.title,
          learnedAlias: grounded.heard,
        },
      ],
    };
  }
  return {
    status: "needs-input",
    prompt: grounded.prompt,
    choices: grounded.candidates.map(({ label }) => label),
    candidates: grounded.candidates.map(({ project, label, learnedAlias }) => ({
      projectId: project.id,
      label,
      ...(learnedAlias === undefined ? {} : { learnedAlias }),
    })),
  };
}
