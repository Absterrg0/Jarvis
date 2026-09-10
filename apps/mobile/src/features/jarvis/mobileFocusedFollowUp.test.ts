import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { groundVoiceTurn } from "@t3tools/jarvis-core/groundVoiceTurn";

const laptop = EnvironmentId.make("laptop");
const desktop = EnvironmentId.make("desktop");

function project(
  nodeId: EnvironmentId,
  id: string,
  title: string,
  nodeLabel: string,
): JarvisMeshProject {
  const projectId = ProjectId.make(id);
  return {
    projectId,
    nodeId,
    ref: { nodeId, projectId },
    nodeLabel,
    title,
    workspaceRoot: `/workspace/${id}`,
    repositoryNames: [title],
    aliases: [],
    aliasDetails: [],
  };
}

const jarvis = project(laptop, "jarvis", "Jarvis", "Laptop");
const alertify = project(desktop, "alertify", "Alertify", "Desktop");

function candidates() {
  return [jarvis, alertify].map((value) => ({
    id: `${value.ref.nodeId}:${value.ref.projectId}`,
    title: value.title,
    label: `${value.title} — ${value.nodeLabel}`,
    names: [value.title, ...value.repositoryNames, ...value.aliases],
    project: value,
  }));
}

/**
 * Cross-layer contract: the mobile client owns the cheap question heuristic,
 * the semantic supervisor owns task continuation. Question-shaped follow-ups
 * carry no phonetic project slot, so nothing client-side may claim them for
 * a project or for project-free conversation: they always reach the single
 * interpret call, and the execution node decides continue vs converse.
 * (The provider half of this contract lives in
 * JarvisMobileProvider.test.tsx: a question with a focused task reaches
 * interpret and execute, never client-side converse.)
 */
describe("mobile focused follow-up routing contract", () => {
  it.each(["What's the status?", "Why did that fail?", "is that a good architecture?"])(
    "carries no project slot, so only task context may claim it: %s",
    (utterance) => {
      expect(groundVoiceTurn({ utterance, candidates: candidates() }).status).toBe("not-mentioned");
    },
  );
});
