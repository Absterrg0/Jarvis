import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groundVoiceTurn } from "./groundVoiceTurn.ts";

const project = (id: string, title: string, workspaceRoot: string) => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot,
  repositoryNames: [],
});

describe("groundVoiceTurn", () => {
  const rivvl = project("project-rivvl", "Rivvl", "/workspace/rivvl");
  const alertify = project("project-alertify", "Alertify", "/workspace/alertify");
  const projects = [rivvl, alertify];

  it("stops before ambient fallback when a project slot has one phonetic match", () => {
    expect(
      groundVoiceTurn({
        utterance: "Can I check out if there is any PR on alert effect?",
        currentProjectId: rivvl.id,
        projects,
        learnedPronunciations: [],
      }),
    ).toEqual({
      status: "needs-confirmation",
      sourceUtterance: "Can I check out if there is any PR on alert effect?",
      heard: "alert effect",
      prompt: "Did you mean Alertify?",
      project: alertify,
    });
  });
});
