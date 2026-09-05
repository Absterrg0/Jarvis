import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { groundVoiceTurn } from "@t3tools/jarvis-core/groundVoiceTurn";

import { resolveMobileJarvisInstructionRoute } from "./mobileJarvisRouting";

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
const online = [{ nodeId: laptop, label: "Laptop", reachability: "online" }] as const;

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
 * the semantic supervisor owns task continuation. Mobile must never resolve
 * a focused follow-up into project-free conversation; it routes to the
 * execute path and lets the supervisor choose continue vs converse.
 */
describe("mobile focused follow-up routing contract", () => {
  it.each(["What's the status?", "Why did that fail?", "is that a good architecture?"])(
    "carries no project slot, so only task context may claim it: %s",
    (utterance) => {
      expect(groundVoiceTurn({ utterance, candidates: candidates() }).status).toBe("not-mentioned");
    },
  );

  it.each(["What's the status?", "Why did that fail?", "is that a good architecture?"])(
    "defers a focused follow-up to the execute path, never converse: %s",
    (utterance) => {
      expect(
        resolveMobileJarvisInstructionRoute({
          utterance,
          inputMode: "voice",
          projects: [jarvis, alertify],
          ambientProject: jarvis,
          nodes: [...online],
          focusedTaskState: "focused",
        }),
      ).toMatchObject({ status: "resolved", project: jarvis });
    },
  );

  it("still converses for the same question shape with no task context", () => {
    expect(
      resolveMobileJarvisInstructionRoute({
        utterance: "What's the status?",
        inputMode: "voice",
        projects: [jarvis, alertify],
        ambientProject: jarvis,
        nodes: [...online],
        focusedTaskState: "unfocused",
      }),
    ).toMatchObject({ status: "converse" });
  });

  it.each(["unknown", undefined] as const)(
    "treats a %s desk snapshot as unknown and defers to execution: %s",
    (focusedTaskState) => {
      // Reconnect/foreground race: desk has not arrived yet, so the client
      // must not assume "no focused task" and bypass the supervisor.
      expect(
        resolveMobileJarvisInstructionRoute({
          utterance: "What's the status?",
          inputMode: "voice",
          projects: [jarvis, alertify],
          ambientProject: jarvis,
          nodes: [...online],
          ...(focusedTaskState === undefined ? {} : { focusedTaskState }),
        }),
      ).toMatchObject({ status: "resolved", project: jarvis });
    },
  );

  it("lets an explicit project mention win over focused context", () => {
    expect(
      resolveMobileJarvisInstructionRoute({
        utterance: "In Alertify, review the latest changes.",
        inputMode: "voice",
        projects: [jarvis, alertify],
        ambientProject: jarvis,
        nodes: [...online],
        focusedTaskState: "focused",
      }),
    ).toMatchObject({ status: "resolved", project: alertify });
  });
});
