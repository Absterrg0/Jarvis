import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProjectTarget } from "./resolveProjectTarget.ts";

const project = (id: string, title: string, workspaceRoot: string, name?: string) => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot,
  ...(name === undefined
    ? {}
    : {
        repositoryIdentity: {
          canonicalKey: `github:owner/${name}`,
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: "https://example.com",
          },
          name,
        },
      }),
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
});

describe("resolveProjectTarget", () => {
  const projects = [
    project("project-rivvl", "Rivvl", "/workspace/rivvl-app", "rivvl"),
    project("project-alertify", "Alertify", "/workspace/alertify"),
  ];

  it("resolves titles, workspace names, and repository names", () => {
    for (const utterance of [
      "Switch to the Rivvl project",
      "Do that in the rivvl-app workspace",
      "Move it into the rivvl repo",
      "Do that in the auth module in the Rivvl project",
      "Use the current project settings, then do that in the Rivvl project",
    ]) {
      expect(resolveProjectTarget({ utterance, projects })).toEqual({
        status: "resolved",
        projectId: ProjectId.make("project-rivvl"),
      });
    }
  });

  it("asks before using a close pronunciation or phonetic collision", () => {
    expect(resolveProjectTarget({ utterance: "Move it into the ripple repo", projects })).toEqual({
      status: "needs-input",
      prompt: "Did you mean Rivvl?",
      choices: ["Rivvl"],
      candidates: [{ projectId: ProjectId.make("project-rivvl"), label: "Rivvl" }],
    });
    const colliding = [
      project("project-code", "Code", "/workspace/code"),
      project("project-cat", "Cat", "/workspace/cat"),
    ];
    expect(
      resolveProjectTarget({ utterance: "Switch to the cut project", projects: colliding }),
    ).toMatchObject({ status: "needs-input", choices: ["Code", "Cat"] });
  });

  it("returns grounded choices instead of inventing a project", () => {
    expect(resolveProjectTarget({ utterance: "Switch to Payments project", projects })).toEqual({
      status: "needs-input",
      prompt: "I couldn't match “Payments” to a T3 project.",
      choices: ["Rivvl", "Alertify"],
      candidates: [
        { projectId: ProjectId.make("project-rivvl"), label: "Rivvl" },
        { projectId: ProjectId.make("project-alertify"), label: "Alertify" },
      ],
    });
  });
});
