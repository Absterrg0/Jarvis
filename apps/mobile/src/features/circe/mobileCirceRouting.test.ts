import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { CirceMeshProject } from "@circe/client-runtime/circe/mesh";

import {
  resolveMobileCircePendingAnswer,
  resolveMobileCirceRouteChoice,
} from "./mobileCirceRouting";

const laptop = EnvironmentId.make("laptop");
const desktop = EnvironmentId.make("desktop");

function project(
  nodeId: EnvironmentId,
  id: string,
  title: string,
  nodeLabel: string,
): CirceMeshProject {
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

const circe = project(laptop, "circe", "Circe", "Laptop");
const alertify = project(desktop, "alertify", "Alertify", "Desktop");

describe("mobile pending route answers", () => {
  it("accepts a spoken project name or ordinal for a pending route", () => {
    const pending = {
      utterance: "Review the latest changes.",
      sourceUtterance: "Review the latest changes.",
      candidates: [
        { project: circe, label: "Circe — Laptop" },
        { project: alertify, label: "Alertify — Desktop" },
      ],
      acceptsAffirmation: false,
    } as const;

    expect(resolveMobileCirceRouteChoice({ pending, answer: "Alertify" })).toMatchObject({
      status: "resolved",
      project: alertify,
    });
    expect(resolveMobileCirceRouteChoice({ pending, answer: "the first one" })).toMatchObject({
      status: "resolved",
      project: circe,
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
    expect(resolveMobileCirceRouteChoice({ pending, answer: "yes" })).toMatchObject({
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
      expect(resolveMobileCircePendingAnswer({ pending, answer })).toEqual({
        status: "discarded",
      });
    }
    expect(resolveMobileCircePendingAnswer({ pending, answer: "yes" })).toMatchObject({
      status: "resolved",
      project: rivvl,
    });
  });

  it("exits a multi-candidate clarification on cancel instead of asking again", () => {
    const pending = {
      utterance: "Review the latest changes.",
      sourceUtterance: "Review the latest changes.",
      candidates: [
        { project: circe, label: "Circe — Laptop" },
        { project: alertify, label: "Alertify — Desktop" },
      ],
      acceptsAffirmation: false,
    } as const;
    for (const answer of ["cancel", "no", "never mind"]) {
      expect(resolveMobileCircePendingAnswer({ pending, answer })).toEqual({
        status: "discarded",
      });
    }
    // A fresh instruction that names no candidate stays pending, and a named
    // candidate still resolves with the original request wording intact.
    expect(resolveMobileCircePendingAnswer({ pending, answer: "start something new" })).toEqual({
      status: "unmatched",
    });
    expect(resolveMobileCircePendingAnswer({ pending, answer: "Alertify" })).toMatchObject({
      status: "resolved",
      project: alertify,
      utterance: "Review the latest changes.",
    });
  });
});
