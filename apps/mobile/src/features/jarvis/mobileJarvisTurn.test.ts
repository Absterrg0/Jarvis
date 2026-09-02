import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachMobileJarvisTask,
  createMobileJarvisVoiceTurn,
  routeMobileJarvisTurn,
} from "./mobileJarvisTurn";

describe("mobile Jarvis turn routing", () => {
  it("pins execution and voice nodes independently for the lifetime of a voice turn", () => {
    const executionNodeId = EnvironmentId.make("vps");
    const voiceNodeId = EnvironmentId.make("desktop");
    const draft = createMobileJarvisVoiceTurn({
      originInteractionId: "mobile-turn-a",
      voiceNodeId,
    });
    const turn = routeMobileJarvisTurn(draft, {
      nodeId: executionNodeId,
      projectId: ProjectId.make("jarvis"),
    });

    expect(turn).toMatchObject({
      projectRef: { nodeId: executionNodeId },
      voiceNodeId,
      speechEnabled: true,
    });
  });

  it("attaches task identity without changing the pinned presentation route", () => {
    const draft = createMobileJarvisVoiceTurn({
      originInteractionId: "mobile-turn-b",
      voiceNodeId: EnvironmentId.make("laptop"),
    });
    const turn = routeMobileJarvisTurn(draft, {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("jarvis"),
    });
    const taskRef = {
      executionNodeId: EnvironmentId.make("desktop"),
      threadId: ThreadId.make("thread-b"),
    };

    expect(attachMobileJarvisTask(turn, taskRef)).toEqual({ ...turn, taskRef });
  });
});
