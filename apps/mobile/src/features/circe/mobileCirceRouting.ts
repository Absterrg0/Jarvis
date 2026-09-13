import type { EnvironmentId } from "@t3tools/contracts";
import { isCirceClarificationDiscard } from "@circe/core/clarification";
import type { CirceMeshProject } from "@circe/client-runtime/circe/mesh";
import { groundVoiceTurn } from "@circe/core/groundVoiceTurn";

type MobileCirceRouteCandidate = {
  readonly project: CirceMeshProject;
  readonly label: string;
};

export type MobileCirceInstructionRoute =
  | {
      readonly status: "resolved";
      readonly project: CirceMeshProject;
      readonly utterance: string;
      readonly sourceUtterance: string;
    }
  | {
      readonly status: "needs-input";
      readonly prompt: string;
      readonly utterance: string;
      readonly sourceUtterance: string;
      readonly candidates: ReadonlyArray<MobileCirceRouteCandidate>;
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

export type MobileCircePendingRoute = Extract<
  MobileCirceInstructionRoute,
  { readonly status: "needs-input" }
>;

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

export function resolveMobileCirceRouteChoice(input: {
  readonly pending: Pick<
    MobileCircePendingRoute,
    "utterance" | "sourceUtterance" | "candidates" | "acceptsAffirmation"
  >;
  readonly answer: string;
}): Extract<MobileCirceInstructionRoute, { readonly status: "resolved" }> | null {
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
        sourceUtterance: input.pending.sourceUtterance,
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

export type MobileCircePendingAnswer =
  | { readonly status: "discarded" }
  | { readonly status: "unmatched" }
  | Extract<MobileCirceInstructionRoute, { readonly status: "resolved" }>;

/**
 * One shared pending-clarification transition for mobile text and voice.
 * An explicit discard exits any clarification type (one-candidate
 * confirmation and multi-candidate clarification alike) before choice
 * matching runs; anything unmatchable stays pending with the route intact.
 * Callers clear their pending route on discarded and keep the original
 * request identity only while the pending interaction remains active.
 */
export function resolveMobileCircePendingAnswer(input: {
  readonly pending: Pick<
    MobileCircePendingRoute,
    "utterance" | "sourceUtterance" | "candidates" | "acceptsAffirmation"
  >;
  readonly answer: string;
}): MobileCircePendingAnswer {
  if (isCirceClarificationDiscard(input.answer)) return { status: "discarded" };
  return (
    resolveMobileCirceRouteChoice({ pending: input.pending, answer: input.answer }) ?? {
      status: "unmatched",
    }
  );
}
