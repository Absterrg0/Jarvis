import { ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { buildProjectVocabulary, groupJarvisAliasesByProject } from "./buildProjectVocabulary.ts";

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

it("matches the naive per-project filter exactly on an interleaved catalog", () => {
  const now = DateTime.makeUnsafe("2026-08-14T00:00:00.000Z");
  const nowIso = DateTime.formatIso(now);
  const projects = Array.from({ length: 60 }, (_, index) => ({
    id: ProjectId.make(`project-${index}`),
    title: `Project ${index}`,
    workspaceRoot: `/work/project-${index}`,
    repositoryIdentity: undefined,
    defaultModelSelection: null,
    scripts: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
  // Interleave aliases across projects so grouping order matters.
  const aliases = Array.from({ length: 600 }, (_, index) => ({
    projectId: ProjectId.make(`project-${(index * 7) % 60}`),
    alias: `alias-${index}`,
    kind: "user-defined" as const,
    updatedAt: now,
  }));
  const grouped = groupJarvisAliasesByProject(aliases);
  expect(grouped.size).toBe(60);
  expect(buildProjectVocabulary({ projects, aliases })).toEqual(
    projects.map((project) => ({
      projectId: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryNames: [],
      aliases: aliases
        .filter((alias) => alias.projectId === project.id)
        .map((alias) => alias.alias),
      aliasDetails: aliases
        .filter((alias) => alias.projectId === project.id)
        .map(({ alias, kind }) => ({ alias, kind })),
    })),
  );
});
