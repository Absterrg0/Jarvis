import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";

import {
  resolveMobileJarvisInstructionRoute,
  resolveMobileJarvisRouteChoice,
} from "./mobileJarvisRouting";

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

describe("mobile Jarvis instruction routing", () => {
  it("routes a spoken project mention instead of pinning the ambient project", () => {
    expect(
      resolveMobileJarvisInstructionRoute({
        utterance: "In Alertify, review the latest changes.",
        inputMode: "voice",
        projects: [jarvis, alertify],
        ambientProject: jarvis,
      }),
    ).toMatchObject({
      status: "resolved",
      project: alertify,
      utterance: "In Alertify, review the latest changes.",
    });
  });

  it("uses activity context without making the user choose a project", () => {
    expect(
      resolveMobileJarvisInstructionRoute({
        utterance: "Continue fixing the microphone.",
        inputMode: "voice",
        projects: [jarvis, alertify],
        ambientProject: jarvis,
      }),
    ).toMatchObject({ status: "resolved", project: jarvis });
  });

  it("asks only when no deterministic route exists", () => {
    expect(
      resolveMobileJarvisInstructionRoute({
        utterance: "Review the latest changes.",
        inputMode: "voice",
        projects: [jarvis, alertify],
        ambientProject: undefined,
      }),
    ).toMatchObject({
      status: "needs-input",
      candidates: [{ project: jarvis }, { project: alertify }],
    });
  });

  it("answers conversationally with no projects when a node is online", () => {
    expect(
      resolveMobileJarvisInstructionRoute({
        utterance: "What is new today?",
        inputMode: "voice",
        projects: [],
        ambientProject: undefined,
        nodes: [{ nodeId: laptop, label: "Laptop", reachability: "online" }],
      }),
    ).toMatchObject({
      status: "converse",
      utterance: "What is new today?",
    });
  });

  it("answers a general question directly instead of pinning ambient work", () => {
    expect(
      resolveMobileJarvisInstructionRoute({
        utterance: "what is the weather today",
        inputMode: "voice",
        projects: [jarvis, alertify],
        ambientProject: jarvis,
        nodes: [{ nodeId: laptop, label: "Laptop", reachability: "online" }],
      }),
    ).toMatchObject({
      status: "converse",
      utterance: "what is the weather today",
    });
  });

  it("keeps project work when no node can answer conversationally", () => {
    expect(
      resolveMobileJarvisInstructionRoute({
        utterance: "what is the weather today",
        inputMode: "voice",
        projects: [jarvis, alertify],
        ambientProject: jarvis,
        nodes: [],
      }),
    ).toMatchObject({ status: "resolved", project: jarvis });
  });

  it("accepts a spoken project name or ordinal for a pending route", () => {
    const pending = {
      utterance: "Review the latest changes.",
      sourceUtterance: "Review the latest changes.",
      candidates: [
        { project: jarvis, label: "Jarvis — Laptop" },
        { project: alertify, label: "Alertify — Desktop" },
      ],
      acceptsAffirmation: false,
    } as const;

    expect(resolveMobileJarvisRouteChoice({ pending, answer: "Alertify" })).toMatchObject({
      status: "resolved",
      project: alertify,
    });
    expect(resolveMobileJarvisRouteChoice({ pending, answer: "the first one" })).toMatchObject({
      status: "resolved",
      project: jarvis,
    });
  });

  it("canonicalizes the misheard span when the user affirms the guess", () => {
    const rivvl = project(laptop, "rivvl", "Rivvl", "Laptop");
    const route = resolveMobileJarvisInstructionRoute({
      utterance: "check the authentication in Rebel.",
      inputMode: "voice",
      projects: [rivvl],
      ambientProject: undefined,
    });
    expect(route).toMatchObject({ status: "needs-input", acceptsAffirmation: true });
    if (route.status !== "needs-input") return;
    expect(resolveMobileJarvisRouteChoice({ pending: route, answer: "yes" })).toMatchObject({
      status: "resolved",
      project: rivvl,
      utterance: "check the authentication in Rivvl.",
    });
  });
});
