import type { CirceMeshProject } from "@circe/client-runtime/circe/mesh";
import { groundVoiceTurn } from "@circe/core/groundVoiceTurn";

/**
 * Voice project grounding shared by live delegations and typed turns.
 * Phonetic matches pause for confirmation; tied names become labeled
 * choices. Never authorizes a route on its own.
 */
export type CirceVoiceProjectMention = {
  readonly project: CirceMeshProject;
  readonly confidence: "exact" | "near" | "phonetic";
  readonly heard: string;
  readonly transcript: string;
};

export type CirceVoiceProjectGrounding =
  | { readonly status: "not-mentioned" }
  | { readonly status: "resolved"; readonly mention: CirceVoiceProjectMention }
  | {
      readonly status: "needs-confirmation";
      readonly project: CirceMeshProject;
      readonly heard: string;
      readonly prompt: string;
    }
  | {
      readonly status: "needs-clarification";
      readonly heard: string;
      readonly prompt: string;
      readonly candidates: ReadonlyArray<{
        readonly project: CirceMeshProject;
        readonly label: string;
      }>;
    };

const projectCandidate = (project: CirceMeshProject) => ({
  id: `${project.ref.nodeId}:${project.ref.projectId}`,
  title: project.title,
  label: `${project.title} — ${project.nodeLabel}`,
  names: [project.title, ...project.repositoryNames, ...project.aliases],
  project,
});

export function groundCirceVoiceProjectMention(input: {
  readonly transcript: string;
  readonly projects: ReadonlyArray<CirceMeshProject>;
}): CirceVoiceProjectGrounding {
  const candidates = input.projects.map(projectCandidate);
  const grounded = groundVoiceTurn({ utterance: input.transcript, candidates });
  if (grounded.status === "not-mentioned") return { status: "not-mentioned" };
  if (grounded.status === "needs-clarification") {
    return {
      status: "needs-clarification",
      heard: grounded.heard,
      prompt: grounded.prompt,
      candidates: grounded.candidates,
    };
  }
  if (grounded.status === "resolved") {
    return {
      status: "resolved",
      mention: {
        project: grounded.project,
        confidence: grounded.match === "near" ? "near" : "exact",
        heard: grounded.heard.toLocaleLowerCase("en-US"),
        transcript: grounded.utterance,
      },
    };
  }
  return {
    status: "needs-confirmation",
    project: grounded.project,
    heard: grounded.heard,
    prompt: grounded.prompt,
  };
}
