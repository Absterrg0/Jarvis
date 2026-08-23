import { ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { buildProjectVocabulary } from "./buildProjectVocabulary.ts";

it("combines live project identities with learned aliases and drops orphaned aliases", () => {
  const now = DateTime.makeUnsafe("2026-08-14T00:00:00.000Z");
  const nowIso = DateTime.formatIso(now);
  expect(
    buildProjectVocabulary({
      projects: [
        {
          id: ProjectId.make("project-rivvl"),
          title: "Rivvl",
          workspaceRoot: "/work/rivvl-app",
          repositoryIdentity: {
            canonicalKey: "github:acme/rivvl",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://example.com/acme/rivvl.git",
            },
            displayName: "acme/rivvl",
            name: "rivvl",
          },
          defaultModelSelection: null,
          scripts: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      aliases: [
        {
          projectId: ProjectId.make("project-rivvl"),
          alias: "ripple",
          kind: "confirmed-pronunciation",
          updatedAt: now,
        },
        {
          projectId: ProjectId.make("project-deleted"),
          alias: "old project",
          kind: "confirmed-pronunciation",
          updatedAt: now,
        },
      ],
    }),
  ).toEqual([
    {
      projectId: "project-rivvl",
      title: "Rivvl",
      workspaceRoot: "/work/rivvl-app",
      repositoryNames: ["acme/rivvl", "rivvl"],
      aliases: ["ripple"],
      aliasDetails: [{ alias: "ripple", kind: "confirmed-pronunciation" }],
    },
  ]);
});
