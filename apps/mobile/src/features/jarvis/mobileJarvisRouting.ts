import type { EnvironmentId } from "@t3tools/contracts";
import type {
  JarvisMeshProject,
  JarvisMeshReachability,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { groundVoiceTurn } from "@t3tools/jarvis-core/groundVoiceTurn";

/** Minimal node shape for conversation routing: identity, liveness, and the
 * node's own advertised supervisor readiness. Unknown (undefined) predates
 * the capability and still falls back to first-online; explicit false is
 * never selected. */
export interface MobileJarvisConverseNode {
  readonly nodeId: EnvironmentId;
  readonly label: string;
  readonly reachability: JarvisMeshReachability;
  readonly conversationReady?: boolean;
}

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

function isConverseQuestion(sourceUtterance: string): boolean {
  const question = sourceUtterance.trim();
  return question.endsWith("?") || GENERAL_QUESTION_PATTERN.test(question);
}

/**
 * Node choice uses the node's own advertised supervisor readiness: the
 * first online conversation-ready node wins, unknown-capability nodes are
 * a fallback for predating catalogs, and explicitly unready nodes are
 * never selected.
 */
function selectConverseNode(
  nodes: ReadonlyArray<MobileJarvisConverseNode> | undefined,
): MobileJarvisConverseNode | undefined {
  const online = (nodes ?? []).filter((node) => node.reachability === "online");
  return (
    online.find((node) => node.conversationReady === true) ??
    online.find((node) => node.conversationReady !== false)
  );
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
  readonly nodes?: ReadonlyArray<MobileJarvisConverseNode>;
  /**
   * Focused-task snapshot authority for the converse shortcut:
   * - "focused": a current snapshot names a focused task; question-shaped
   *   follow-ups ("what's the status?") must reach the semantic path as
   *   potential continuations, never project-free conversation.
   * - "unfocused": a current snapshot positively shows no focused task;
   *   the shortcut may apply.
   * - "unknown" (or omitted): desk not loaded yet or stale after a node
   *   switch; never take the shortcut, defer to server execution.
   */
  readonly focusedTaskState?: "focused" | "unfocused" | "unknown";
}): MobileJarvisInstructionRoute {
  const sourceUtterance = input.utterance.trim();
  if (input.projects.length === 0) {
    // No execution catalog at all: answer on a conversation-ready node
    // instead of stranding fresh installs.
    const onlineNode = selectConverseNode(input.nodes);
    if (onlineNode === undefined) {
      const anyOnline = (input.nodes ?? []).some((node) => node.reachability === "online");
      return {
        status: "unavailable",
        message: anyOnline
          ? "No Jarvis conversation provider is ready. Check the node's provider setup."
          : "Connect a Jarvis execution node before starting work.",
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
  // Question-shaped utterances with a positively unfocused desk are
  // conversation; with a focused or unknown desk they stay on the execute
  // path so the supervisor decides.
  if (grounded.status === "not-mentioned" && input.focusedTaskState === "unfocused") {
    if (isConverseQuestion(sourceUtterance)) {
      const node = selectConverseNode(input.nodes);
      if (node !== undefined) {
        return {
          status: "converse",
          nodeId: node.nodeId,
          utterance: sourceUtterance,
          sourceUtterance,
        };
      }
      // No suitable node: an ambient or single-project fallback still lets
      // the server decide (it may answer via execute). Only the true dead
      // end — clarification would interrogate a general question — is a
      // deterministic unavailable.
      const hasFallback =
        (ambientProject !== undefined &&
          input.projects.some(
            (project) =>
              project.ref.nodeId === ambientProject.ref.nodeId &&
              project.ref.projectId === ambientProject.ref.projectId,
          )) ||
        input.projects.length === 1;
      if (!hasFallback) {
        const anyOnline = (input.nodes ?? []).some((node) => node.reachability === "online");
        return {
          status: "unavailable",
          message: anyOnline
            ? "No Jarvis conversation provider is ready. Check the node's provider setup."
            : "Connect a Jarvis execution node before starting work.",
        };
      }
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
