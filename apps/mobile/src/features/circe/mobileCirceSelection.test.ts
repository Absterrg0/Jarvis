import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { CirceMeshProject } from "@circe/client-runtime/circe/mesh";

import { resolveMobileCirceProject } from "./mobileCirceSelection";

const desktopId = EnvironmentId.make("desktop");

function project(id: string, title: string): CirceMeshProject {
  const projectId = ProjectId.make(id);
  return {
    projectId,
    nodeId: desktopId,
    ref: { nodeId: desktopId, projectId },
    nodeLabel: "Desktop",
    title,
    workspaceRoot: `/workspace/${id}`,
    repositoryNames: [title],
    aliases: [],
    aliasDetails: [],
  };
}

const alertify = project("alertify", "Alertify");
const rivvl = project("rivvl", "rivvl");
const projectKey = (candidate: CirceMeshProject) =>
  `${candidate.ref.nodeId}:${candidate.ref.projectId}`;

describe("mobile Circe project defaults", () => {
  it("keeps the current valid selection", () => {
    expect(
      resolveMobileCirceProject({
        projects: [alertify, rivvl],
        selectedProjectKey: projectKey(rivvl),
        preferredProjectRef: alertify.ref,
        projectKey,
      }),
    ).toBe(rivvl);
  });

  it("restores the last preferred project", () => {
    expect(
      resolveMobileCirceProject({
        projects: [alertify, rivvl],
        selectedProjectKey: null,
        preferredProjectRef: rivvl.ref,
        projectKey,
      }),
    ).toBe(rivvl);
  });

  it("leaves reports without authority when several projects exist", () => {
    // Task and report activity used to choose here; now several projects with
    // no explicit selection stay unresolved instead of borrowing a target.
    expect(
      resolveMobileCirceProject({
        projects: [alertify, rivvl],
        selectedProjectKey: null,
        preferredProjectRef: undefined,
        projectKey,
      }),
    ).toBeUndefined();
  });

  it("pins an explicit selection instead of falling back on outage", () => {
    expect(
      resolveMobileCirceProject({
        projects: [alertify],
        selectedProjectKey: projectKey(rivvl),
        preferredProjectRef: alertify.ref,
        projectKey,
      }),
    ).toBeUndefined();
  });

  it("pins an explicit preference instead of borrowing a survivor on removal", () => {
    expect(
      resolveMobileCirceProject({
        projects: [alertify],
        selectedProjectKey: null,
        preferredProjectRef: rivvl.ref,
        projectKey,
      }),
    ).toBeUndefined();
  });

  it("selects a sole project but leaves a new ambiguous catalog unresolved", () => {
    expect(
      resolveMobileCirceProject({
        projects: [alertify],
        selectedProjectKey: null,
        preferredProjectRef: undefined,
        projectKey,
      }),
    ).toBe(alertify);
    expect(
      resolveMobileCirceProject({
        projects: [alertify, rivvl],
        selectedProjectKey: null,
        preferredProjectRef: undefined,
        projectKey,
      }),
    ).toBeUndefined();
  });
});
