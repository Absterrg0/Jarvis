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
        focusedTaskState: "unfocused",
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
        focusedTaskState: "unfocused",
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
        focusedTaskState: "unfocused",
      }),
    ).toMatchObject({ status: "resolved", project: jarvis });
  });

  it("still converses without task context so no junk work is created", () => {
    expect(
      resolveMobileJarvisInstructionRoute({
        utterance: "What's the status?",
        inputMode: "voice",
        projects: [jarvis, alertify],
        ambientProject: jarvis,
        nodes: [{ nodeId: laptop, label: "Laptop", reachability: "online" }],
        focusedTaskState: "unfocused",
      }),
    ).toMatchObject({ status: "converse" });
  });

  it.each(["What's the status?", "Why did that fail?", "is that a good architecture?"])(
    "keeps a focused follow-up on the task instead of conversing: %s",
    (utterance) => {
      expect(
        resolveMobileJarvisInstructionRoute({
          utterance,
          inputMode: "voice",
          projects: [jarvis, alertify],
          ambientProject: jarvis,
          nodes: [{ nodeId: laptop, label: "Laptop", reachability: "online" }],
          focusedTaskState: "focused",
        }),
      ).toMatchObject({ status: "resolved", project: jarvis });
    },
  );

  it("prefers a conversation-ready node over first-online", () => {
    const vps = EnvironmentId.make("vps");
    const route = resolveMobileJarvisInstructionRoute({
      utterance: "what is quantum computing?",
      inputMode: "voice",
      projects: [jarvis, alertify],
      ambientProject: undefined,
      nodes: [
        { nodeId: vps, label: "VPS", reachability: "online", conversationReady: false },
        { nodeId: laptop, label: "Laptop", reachability: "online", conversationReady: true },
      ],
      focusedTaskState: "unfocused",
    });
    expect(route).toMatchObject({ status: "converse", nodeId: laptop });
  });

  it("falls back to unknown-capability nodes but never an explicitly unready one", () => {
    const vps = EnvironmentId.make("vps");
    const route = resolveMobileJarvisInstructionRoute({
      utterance: "what is quantum computing?",
      inputMode: "voice",
      projects: [jarvis, alertify],
      ambientProject: undefined,
      nodes: [
        { nodeId: vps, label: "VPS", reachability: "online" },
        { nodeId: laptop, label: "Laptop", reachability: "online", conversationReady: false },
      ],
      focusedTaskState: "unfocused",
    });
    expect(route).toMatchObject({ status: "converse", nodeId: vps });
  });

  it("reports no conversation provider when every online node is explicitly unready", () => {
    const vps = EnvironmentId.make("vps");
    const desktop = EnvironmentId.make("desktop");
    const other = project(desktop, "other", "Other", "Desktop");
    expect(
      resolveMobileJarvisInstructionRoute({
        utterance: "what is quantum computing?",
        inputMode: "voice",
        projects: [jarvis, other],
        ambientProject: undefined,
        nodes: [
          { nodeId: vps, label: "VPS", reachability: "online", conversationReady: false },
          { nodeId: laptop, label: "Laptop", reachability: "online", conversationReady: false },
        ],
        focusedTaskState: "unfocused",
      }),
    ).toMatchObject({
      status: "unavailable",
      message: "No Jarvis conversation provider is ready. Check the node's provider setup.",
    });
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
