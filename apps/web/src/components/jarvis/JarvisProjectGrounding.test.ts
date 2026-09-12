import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveVoiceConfirmation } from "@t3tools/jarvis-core/confirmation";
import type { JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";

import { groundJarvisVoiceProjectMention } from "./JarvisProjectGrounding";

describe("Jarvis voice project grounding", () => {
  it("catches the observed Alertify transcription before it reaches an agent", () => {
    const nodeId = EnvironmentId.make("node-1");
    const alertifyProjectId = ProjectId.make("alertify");
    const jarvisProjectId = ProjectId.make("jarvis");
    const alertify: JarvisMeshProject = {
      projectId: alertifyProjectId,
      ref: { nodeId, projectId: alertifyProjectId },
      nodeLabel: "Laptop",
      title: "Alertify",
      workspaceRoot: "/work/Alertify",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    };
    const jarvis: JarvisMeshProject = {
      projectId: jarvisProjectId,
      ref: { nodeId, projectId: jarvisProjectId },
      nodeLabel: "Laptop",
      title: "Jarvis",
      workspaceRoot: "/work/Jarvis",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    };

    expect(
      groundJarvisVoiceProjectMention({
        transcript: "Can you please check out Alertifi?",
        projects: [alertify, jarvis],
      }),
    ).toEqual({
      status: "resolved",
      mention: {
        project: alertify,
        confidence: "near",
        heard: "alertifi",
        transcript: "Can you please check out Alertify?",
      },
    });

    expect(
      groundJarvisVoiceProjectMention({
        transcript: "Can you please check out a light defile?",
        projects: [alertify, jarvis],
      }),
    ).toEqual({
      status: "needs-confirmation",
      project: alertify,
      heard: "a light defile",
      prompt: "Did you mean Alertify?",
    });

    expect(
      groundJarvisVoiceProjectMention({
        transcript: "Can you please check out a light defile?",
        projects: [{ ...alertify, aliases: ["a light defile"] }, jarvis],
      }),
    ).toEqual({
      status: "resolved",
      mention: {
        project: { ...alertify, aliases: ["a light defile"] },
        confidence: "exact",
        heard: "a light defile",
        transcript: "Can you please check out Alertify?",
      },
    });
  });

  it("accepts or declines a spoken project correction without guessing", () => {
    expect(resolveVoiceConfirmation("yes, that's right")).toBe("accept");
    expect(resolveVoiceConfirmation("no, not that one")).toBe("decline");
    expect(resolveVoiceConfirmation("maybe another project")).toBeUndefined();
  });

  it("never routes a project-less objective to a phonetic guess", () => {
    const nodeId = EnvironmentId.make("node-1");
    const projectId = ProjectId.make("project-rivvl");
    const rivvl: JarvisMeshProject = {
      projectId,
      ref: { nodeId, projectId },
      nodeLabel: "Laptop",
      title: "Rivvl",
      workspaceRoot: "/work/rivvl",
      repositoryNames: [],
      aliases: [],
      aliasDetails: [],
    };
    const grounded = groundJarvisVoiceProjectMention({
      transcript: "Review latest changes",
      projects: [rivvl],
    });
    expect(grounded.status).not.toBe("resolved");
    if (grounded.status === "resolved") {
      expect(grounded.mention.project.title).not.toBe("Rivvl");
    }
  });
});
