import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";

import {
  resolveMobileJarvisPendingAnswer,
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

describe("mobile pending route answers", () => {
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
    // The parked pending route as the proposal-first provider leaves it:
    // verbatim source plus the confirmed candidate. Answering "yes"
    // canonicalizes the utterance for dispatch while the source stays exact.
    const pending = {
      utterance: "check the authentication in Rebel.",
      sourceUtterance: "check the authentication in Rebel.",
      candidates: [{ project: rivvl, label: "Rivvl — Laptop" }],
      acceptsAffirmation: true,
    } as const;
    expect(resolveMobileJarvisRouteChoice({ pending, answer: "yes" })).toMatchObject({
      status: "resolved",
      project: rivvl,
      utterance: "check the authentication in Rivvl.",
      sourceUtterance: "check the authentication in Rebel.",
    });
  });

  it("exits a one-candidate confirmation on cancel instead of asking again", () => {
    const rivvl = project(laptop, "rivvl", "Rivvl", "Laptop");
    const pending = {
      utterance: "check the authentication in Rebel.",
      sourceUtterance: "check the authentication in Rebel.",
      candidates: [{ project: rivvl, label: "Rivvl — Laptop" }],
      acceptsAffirmation: true,
    } as const;
    for (const answer of ["cancel", "no", "never mind"]) {
      expect(resolveMobileJarvisPendingAnswer({ pending, answer })).toEqual({
        status: "discarded",
      });
    }
    expect(resolveMobileJarvisPendingAnswer({ pending, answer: "yes" })).toMatchObject({
      status: "resolved",
      project: rivvl,
    });
  });

  it("exits a multi-candidate clarification on cancel instead of asking again", () => {
    const pending = {
      utterance: "Review the latest changes.",
      sourceUtterance: "Review the latest changes.",
      candidates: [
        { project: jarvis, label: "Jarvis — Laptop" },
        { project: alertify, label: "Alertify — Desktop" },
      ],
      acceptsAffirmation: false,
    } as const;
    for (const answer of ["cancel", "no", "never mind"]) {
      expect(resolveMobileJarvisPendingAnswer({ pending, answer })).toEqual({
        status: "discarded",
      });
    }
    // A fresh instruction that names no candidate stays pending, and a named
    // candidate still resolves with the original request wording intact.
    expect(resolveMobileJarvisPendingAnswer({ pending, answer: "start something new" })).toEqual({
      status: "unmatched",
    });
    expect(resolveMobileJarvisPendingAnswer({ pending, answer: "Alertify" })).toMatchObject({
      status: "resolved",
      project: alertify,
      utterance: "Review the latest changes.",
    });
  });
});
