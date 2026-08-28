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
      executionPolicy: "default",
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

  it("does not reinterpret a deliberate contextual continuation as a project switch", () => {
    const prepared = prepareJarvisTurn({
      utterance: "Check out Alertifi",
      currentProjectId: rivvl.id,
      projects,
      inputMode: "voice",
      continueContext: true,
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

  it("stops the observed Rivvl misrecognition before provider dispatch", () => {
    expect(
      prepareJarvisTurn({
        utterance: "I need you to check out Zivil.",
        currentProjectId: alertify.id,
        projects,
        inputMode: "voice",
      }),
    ).toMatchObject({
      status: "needs-input",
      prompt: "Did you mean Rivvl?",
      choices: ["Rivvl"],
    });
  });

  it("compiles a confirmed project correction into the canonical provider objective", () => {
    expect(
      prepareJarvisTurn({
        utterance: "I need you to check out Zivil.",
        currentProjectId: alertify.id,
        projects,
        inputMode: "voice",
        confirmedProjectId: rivvl.id,
      }),
    ).toEqual({
      status: "ready",
      sourceUtterance: "I need you to check out Zivil.",
      utterance: "I need you to check out Rivvl.",
      projectId: rivvl.id,
      controlIntent: {
        action: "new-task",
        instruction: "I need you to check out Rivvl.",
      },
      requestKind: "inspection",
      executionPolicy: "default",
    });
  });

  it("routes an explicit project while keeping a literal branch name intact", () => {
    expect(
      prepareJarvisTurn({
        utterance: "In Rivvl, check out branch Zivil.",
        currentProjectId: alertify.id,
        projects,
        inputMode: "voice",
      }),
    ).toMatchObject({
      status: "ready",
      projectId: rivvl.id,
      utterance: "In Rivvl, check out branch Zivil.",
      controlIntent: { instruction: "In Rivvl, check out branch Zivil." },
    });
  });

  it("leaves typed checkout commands outside voice grounding", () => {
    expect(
      prepareJarvisTurn({
        utterance: "git checkout zivil",
        currentProjectId: rivvl.id,
        projects,
      }),
    ).toMatchObject({
      status: "ready",
      projectId: rivvl.id,
      utterance: "git checkout zivil",
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
