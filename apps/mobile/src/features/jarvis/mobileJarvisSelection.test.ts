import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";

import { resolveMobileJarvisProject } from "./mobileJarvisSelection";

const desktopId = EnvironmentId.make("desktop");

function project(id: string, title: string): JarvisMeshProject {
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
const projectKey = (candidate: JarvisMeshProject) =>
  `${candidate.ref.nodeId}:${candidate.ref.projectId}`;

describe("mobile Jarvis project defaults", () => {
  it("keeps the current valid selection", () => {
    expect(
      resolveMobileJarvisProject({
        projects: [alertify, rivvl],
        selectedProjectKey: projectKey(rivvl),
        preferredProjectRef: alertify.ref,
        projectKey,
      }),
    ).toBe(rivvl);
  });

  it("restores the last preferred project", () => {
    expect(
      resolveMobileJarvisProject({
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
      resolveMobileJarvisProject({
        projects: [alertify, rivvl],
        selectedProjectKey: null,
        preferredProjectRef: undefined,
        projectKey,
      }),
    ).toBeUndefined();
  });

  it("pins an explicit selection instead of falling back on outage", () => {
    expect(
      resolveMobileJarvisProject({
        projects: [alertify],
        selectedProjectKey: projectKey(rivvl),
        preferredProjectRef: alertify.ref,
        projectKey,
      }),
    ).toBeUndefined();
  });

  it("pins an explicit preference instead of borrowing a survivor on removal", () => {
    expect(
      resolveMobileJarvisProject({
        projects: [alertify],
        selectedProjectKey: null,
        preferredProjectRef: rivvl.ref,
        projectKey,
      }),
    ).toBeUndefined();
  });

  it("selects a sole project but leaves a new ambiguous catalog unresolved", () => {
    expect(
      resolveMobileJarvisProject({
        projects: [alertify],
        selectedProjectKey: null,
        preferredProjectRef: undefined,
        projectKey,
      }),
    ).toBe(alertify);
    expect(
      resolveMobileJarvisProject({
        projects: [alertify, rivvl],
        selectedProjectKey: null,
        preferredProjectRef: undefined,
        projectKey,
      }),
    ).toBeUndefined();
  });
});
