import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attachMobileJarvisTask, createMobileJarvisVoiceTurn } from "./mobileJarvisTurn";

describe("mobile Jarvis turn routing", () => {
  it("pins execution and voice nodes independently for the lifetime of a voice turn", () => {
    const executionNodeId = EnvironmentId.make("vps");
    const voiceNodeId = EnvironmentId.make("desktop");
    const turn = createMobileJarvisVoiceTurn({
      originInteractionId: "mobile-turn-a",
      projectRef: { nodeId: executionNodeId, projectId: ProjectId.make("jarvis") },
      voiceNodeId,
    });

    expect(turn).toMatchObject({
      projectRef: { nodeId: executionNodeId },
      voiceNodeId,
      speechEnabled: true,
    });
  });

  it("attaches task identity without changing the pinned presentation route", () => {
    const turn = createMobileJarvisVoiceTurn({
      originInteractionId: "mobile-turn-b",
      projectRef: {
        nodeId: EnvironmentId.make("desktop"),
        projectId: ProjectId.make("jarvis"),
      },
      voiceNodeId: EnvironmentId.make("laptop"),
    });
    const taskRef = {
      executionNodeId: EnvironmentId.make("desktop"),
      threadId: ThreadId.make("thread-b"),
    };

    expect(attachMobileJarvisTask(turn, taskRef)).toEqual({ ...turn, taskRef });
  });
});
