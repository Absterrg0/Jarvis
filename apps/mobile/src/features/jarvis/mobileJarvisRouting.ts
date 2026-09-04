import type { EnvironmentId } from "@t3tools/contracts";
import type { JarvisMeshNode, JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
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
      readonly status: "converse";
      readonly nodeId: EnvironmentId;
      readonly utterance: string;
      readonly sourceUtterance: string;
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

const GENERAL_QUESTION_PATTERN =
  /^(?:what|how|why|when|where|who|whom|whose|which|is|are|was|were|do|does|did|can|could|would|should|will|tell|explain)\b/iu;

/**
 * Deterministic converse classification, checked before any project
 * authorization: a question with no project slot is answered directly
 * instead of being pinned to the ambient project as work.
 */
function converseNode(
  sourceUtterance: string,
  nodes: ReadonlyArray<JarvisMeshNode> | undefined,
): JarvisMeshNode | undefined {
  const question = sourceUtterance.trim();
  if (!question.endsWith("?") && !GENERAL_QUESTION_PATTERN.test(question)) {
    return undefined;
  }
  return (nodes ?? []).find((node) => node.reachability === "online");
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
  readonly nodes?: ReadonlyArray<JarvisMeshNode>;
}): MobileJarvisInstructionRoute {
  const sourceUtterance = input.utterance.trim();
  if (input.projects.length === 0) {
    // No execution catalog at all: general questions can still be answered
    // conversationally on any online node instead of stranding fresh installs.
    const onlineNode = (input.nodes ?? []).find((node) => node.reachability === "online");
    if (onlineNode === undefined) {
      return {
        status: "unavailable",
        message: "Connect a Jarvis execution node before starting work.",
      };
    }
    return {
      status: "converse",
      nodeId: onlineNode.nodeId,
      utterance: sourceUtterance,
      sourceUtterance,
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
  if (grounded.status === "not-mentioned") {
    const node = converseNode(sourceUtterance, input.nodes);
    if (node !== undefined) {
      return {
        status: "converse",
        nodeId: node.nodeId,
        utterance: sourceUtterance,
        sourceUtterance,
      };
    }
  }
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
  if (selected === undefined) return null;
  // An affirmation ("yes") carries no project words, so the pending raw
  // utterance still holds the mishearing. Re-ground with the confirmed
  // identity to canonicalize it ("in Rebel" becomes "in Rivvl").
  if (selectedByAffirmation !== undefined) {
    const grounded = groundVoiceTurn({
      utterance: input.pending.sourceUtterance,
      candidates: input.pending.candidates.map(({ project }) => ({
        id: `${project.ref.nodeId}:${project.ref.projectId}`,
        title: project.title,
        label: `${project.title} — ${project.nodeLabel}`,
        names: [project.title, ...project.repositoryNames, ...project.aliases],
        project,
      })),
      confirmedCandidateId: `${selected.project.ref.nodeId}:${selected.project.ref.projectId}`,
    });
    if (grounded.status === "resolved") {
      return {
        status: "resolved",
        project: selected.project,
        utterance: grounded.utterance,
        sourceUtterance: grounded.sourceUtterance,
      };
    }
  }
  return {
    status: "resolved",
    project: selected.project,
    utterance: input.pending.utterance,
    sourceUtterance: input.pending.sourceUtterance,
  };
}
