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
        activityProjectRefs: [],
        projectKey,
      }),
    ).toBe(rivvl);
  });

  it("restores the last project before consulting task history", () => {
    expect(
      resolveMobileJarvisProject({
        projects: [alertify, rivvl],
        selectedProjectKey: null,
        preferredProjectRef: rivvl.ref,
        activityProjectRefs: [alertify.ref],
        projectKey,
      }),
    ).toBe(rivvl);
  });

  it("follows the focused or most recent task when no preference exists", () => {
    expect(
      resolveMobileJarvisProject({
        projects: [alertify, rivvl],
        selectedProjectKey: null,
        preferredProjectRef: undefined,
        activityProjectRefs: [rivvl.ref, alertify.ref],
        projectKey,
      }),
    ).toBe(rivvl);
  });

  it("selects a sole project but leaves a new ambiguous catalog unresolved", () => {
    expect(
      resolveMobileJarvisProject({
        projects: [alertify],
        selectedProjectKey: null,
        preferredProjectRef: undefined,
        activityProjectRefs: [],
        projectKey,
      }),
    ).toBe(alertify);
    expect(
      resolveMobileJarvisProject({
        projects: [alertify, rivvl],
        selectedProjectKey: null,
        preferredProjectRef: undefined,
        activityProjectRefs: [],
        projectKey,
      }),
    ).toBeUndefined();
  });
});
