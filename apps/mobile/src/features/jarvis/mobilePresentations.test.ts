import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { JarvisPresentationEvent } from "@t3tools/contracts";

import type { MobileJarvisPresentation } from "./JarvisMobileProvider";
import { selectCurrentPresentations } from "./mobilePresentations";

function presentation(
  presentationId: string,
  threadId: string,
  kind: JarvisPresentationEvent["kind"],
): MobileJarvisPresentation {
  return {
    executionNodeId: EnvironmentId.make("node-1"),
    event: {
      presentationId,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make(threadId),
      origin: {
        originInteractionId: "interaction-1",
        originNodeId: EnvironmentId.make("node-1"),
      },
      kind,
      threadTitle: "Review task",
      providerName: "Codex",
      text: `${kind} text`,
    } as JarvisPresentationEvent,
  };
}

describe("mobile Jarvis presentation projection", () => {
  it("lets a terminal outcome supersede its thread's earlier blocker", () => {
    expect(
      selectCurrentPresentations([
        presentation("completed-2", "thread-1", "completed"),
        presentation("approval-1", "thread-1", "approval-needed"),
      ]).map((item) => item.event.presentationId),
    ).toEqual(["completed-2"]);
  });

  it("keeps one current presentation per thread", () => {
    expect(
      selectCurrentPresentations([
        presentation("input-2", "thread-2", "waiting-for-input"),
        presentation("failed-1", "thread-1", "failed"),
        presentation("approval-1", "thread-1", "approval-needed"),
      ]).map((item) => item.event.presentationId),
    ).toEqual(["input-2", "failed-1"]);
  });

  it("keeps an ordinary completed task visible", () => {
    expect(
      selectCurrentPresentations([presentation("completed-1", "thread-1", "completed")]),
    ).toHaveLength(1);
  });
});
