import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { prepareJarvisTurn } from "./prepareJarvisTurn.ts";

const project = (id: string, title: string, workspaceRoot: string) => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
});

describe("prepareJarvisTurn", () => {
  const rivvl = project("project-rivvl", "Rivvl", "/workspace/rivvl");
  const alertify = project("project-alertify", "Alertify", "/workspace/Alertify");
  const projects = [rivvl, alertify];

  it("grounds and canonicalizes a named project before provider dispatch", () => {
    expect(
      prepareJarvisTurn({
        utterance: "Can you please check out Alertifi?",
        currentProjectId: rivvl.id,
        projects,
        inputMode: "voice",
      }),
    ).toEqual({
      status: "ready",
      sourceUtterance: "Can you please check out Alertifi?",
      utterance: "Can you please check out Alertify?",
      projectId: alertify.id,
      controlIntent: {
        action: "new-task",
        instruction: "Can you please check out Alertify?",
      },
      requestKind: "inspection",
      executionPolicy: "approval-required",
    });
  });

  it("keeps explicit typed project controls in the same Director path", () => {
    const prepared = prepareJarvisTurn({
      utterance: "Switch to Alertify project",
      currentProjectId: rivvl.id,
      projects,
    });

    expect(prepared).toMatchObject({
      status: "ready",
      utterance: "Switch to Alertify project",
      projectId: alertify.id,
      controlIntent: { action: "focus-project" },
      executionPolicy: "default",
    });
  });

  it("does not reinterpret a contextual continuation as a project switch", () => {
    const prepared = prepareJarvisTurn({
      utterance: "Check out Alertifi",
      currentProjectId: rivvl.id,
      projects,
      inputMode: "voice",
      hasContext: true,
    });

    expect(prepared).toMatchObject({
      status: "ready",
      utterance: "Check out Alertifi",
      projectId: rivvl.id,
    });
  });

  it("asks before dispatching a plausible phonetic project match", () => {
    expect(
      prepareJarvisTurn({
        utterance: "Can you please check out a light defile?",
        currentProjectId: rivvl.id,
        projects,
        inputMode: "voice",
      }),
    ).toMatchObject({
      status: "needs-input",
      prompt: "Did you mean Alertify?",
      choices: ["Alertify"],
    });
  });

  it("keeps explicit change requests on the normal execution policy", () => {
    expect(
      prepareJarvisTurn({
        utterance: "Check out Alertifi and update the broken test",
        currentProjectId: rivvl.id,
        projects,
        inputMode: "voice",
      }),
    ).toMatchObject({
      status: "ready",
      projectId: alertify.id,
      requestKind: "change",
      executionPolicy: "default",
    });
  });
});
