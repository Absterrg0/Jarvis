import type { JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { groundVoiceTurn } from "@t3tools/jarvis-core/groundVoiceTurn";

type MobileJarvisRouteCandidate = {
  readonly project: JarvisMeshProject;
  readonly label: string;
};

export type MobileJarvisInstructionRoute =
  | {
      readonly status: "resolved";
      readonly project: JarvisMeshProject;
      readonly utterance: string;
      readonly sourceUtterance: string;
    }
  | {
      readonly status: "needs-input";
      readonly prompt: string;
      readonly utterance: string;
      readonly sourceUtterance: string;
      readonly candidates: ReadonlyArray<MobileJarvisRouteCandidate>;
      readonly acceptsAffirmation: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly message: string;
    };

export type MobileJarvisPendingRoute = Extract<
  MobileJarvisInstructionRoute,
  { readonly status: "needs-input" }
>;

const candidate = (project: JarvisMeshProject) => ({
  id: `${project.ref.nodeId}:${project.ref.projectId}`,
  title: project.title,
  label: `${project.title} — ${project.nodeLabel}`,
  names: [project.title, ...project.repositoryNames, ...project.aliases],
  project,
});

function normalizeChoice(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function ordinalPosition(answer: string): number | undefined {
  const numeric = /^(?:the\s+)?(\d+)(?:st|nd|rd|th)?(?:\s+one)?$/u.exec(answer)?.[1];
  if (numeric !== undefined) return Number(numeric);
  const words: Readonly<Record<string, number>> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
  };
  const word = /^(?:the\s+)?(first|second|third|fourth|fifth)(?:\s+one)?$/u.exec(answer)?.[1];
  return word === undefined ? undefined : words[word];
}

export function resolveMobileJarvisInstructionRoute(input: {
  readonly utterance: string;
  readonly inputMode: "text" | "voice";
  readonly projects: ReadonlyArray<JarvisMeshProject>;
  readonly ambientProject: JarvisMeshProject | undefined;
}): MobileJarvisInstructionRoute {
  const sourceUtterance = input.utterance.trim();
  if (input.projects.length === 0) {
    return {
      status: "unavailable",
      message: "Connect a Jarvis execution node before starting work.",
    };
  }

  const grounded = groundVoiceTurn({
    utterance: sourceUtterance,
    candidates: input.projects.map(candidate),
    mode: input.inputMode === "voice" ? "explicit-or-inferred" : "explicit-only",
  });
  if (grounded.status === "resolved") {
    return {
      status: "resolved",
      project: grounded.project,
      utterance: grounded.utterance,
      sourceUtterance: grounded.sourceUtterance,
    };
  }
  if (grounded.status === "needs-confirmation") {
    return {
      status: "needs-input",
      prompt: grounded.prompt,
      utterance: sourceUtterance,
      sourceUtterance: grounded.sourceUtterance,
      candidates: [
        {
          project: grounded.project,
          label: `${grounded.project.title} — ${grounded.project.nodeLabel}`,
        },
      ],
      acceptsAffirmation: true,
    };
  }
  if (grounded.status === "needs-clarification") {
    return {
      status: "needs-input",
      prompt: grounded.prompt,
      utterance: sourceUtterance,
      sourceUtterance: grounded.sourceUtterance,
      candidates: grounded.candidates.map(({ project, label }) => ({ project, label })),
      acceptsAffirmation: false,
    };
  }

  const ambientProject = input.ambientProject;
  if (
    ambientProject !== undefined &&
    input.projects.some(
      (project) =>
        project.ref.nodeId === ambientProject.ref.nodeId &&
        project.ref.projectId === ambientProject.ref.projectId,
    )
  ) {
    return {
      status: "resolved",
      project: ambientProject,
      utterance: grounded.utterance,
      sourceUtterance: grounded.sourceUtterance,
    };
  }
  if (input.projects.length === 1) {
    return {
      status: "resolved",
      project: input.projects[0]!,
      utterance: grounded.utterance,
      sourceUtterance: grounded.sourceUtterance,
    };
  }
  return {
    status: "needs-input",
    prompt: "Which project should I use? Say its name or number.",
    utterance: grounded.utterance,
    sourceUtterance: grounded.sourceUtterance,
    candidates: input.projects.slice(0, 5).map((project) => ({
      project,
      label: `${project.title} — ${project.nodeLabel}`,
    })),
    acceptsAffirmation: false,
  };
}

export function resolveMobileJarvisRouteChoice(input: {
  readonly pending: Pick<
    MobileJarvisPendingRoute,
    "utterance" | "sourceUtterance" | "candidates" | "acceptsAffirmation"
  >;
  readonly answer: string;
}): Extract<MobileJarvisInstructionRoute, { readonly status: "resolved" }> | null {
  const answer = normalizeChoice(input.answer);
  const affirmative = /^(?:yes|yeah|yep|correct|that one|use that)$/u.test(answer);
  const selectedByAffirmation =
    input.pending.acceptsAffirmation && affirmative ? input.pending.candidates[0] : undefined;
  const position = ordinalPosition(answer);
  const selectedByPosition =
    position === undefined || position < 1 ? undefined : input.pending.candidates[position - 1];
  const matchingCandidates = input.pending.candidates.filter(({ project, label }) =>
    [project.title, label, ...project.repositoryNames, ...project.aliases].some(
      (name) => normalizeChoice(name) === answer,
    ),
  );
  const selected =
    selectedByAffirmation ??
    selectedByPosition ??
    (matchingCandidates.length === 1 ? matchingCandidates[0] : undefined);
  return selected === undefined
    ? null
    : {
        status: "resolved",
        project: selected.project,
        utterance: input.pending.utterance,
        sourceUtterance: input.pending.sourceUtterance,
      };
}
