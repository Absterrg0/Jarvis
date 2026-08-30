import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type JarvisPresentationEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canMountJarvisVoiceReporter,
  enqueueJarvisPresentation,
  presentationStatus,
  rememberBoundedPresentationId,
  spokenPresentationText,
} from "./JarvisVoiceReporter.logic";

const event = (kind: JarvisPresentationEvent["kind"]): JarvisPresentationEvent => ({
  presentationId: `presentation-${kind}`,
  projectId: ProjectId.make("project-voice"),
  threadId: ThreadId.make("thread-voice"),
  taskRef: {
    executionNodeId: EnvironmentId.make("node-execution"),
    remoteTaskId: "remote-task",
    remoteThreadId: ThreadId.make("thread-voice"),
    projectId: ProjectId.make("project-voice"),
    providerId: ProviderInstanceId.make("codex"),
  },
  origin: {
    originNodeId: EnvironmentId.make("node-origin"),
    originInteractionId: "interaction-voice",
  },
  kind,
  threadTitle: "Voice task",
  providerName: "Codex",
  text: "The requested task is complete.",
  createdAt: "2026-08-30T00:00:00.000Z",
});

describe("Jarvis live voice presentation", () => {
  it("mounts only for authenticated clients with operation scope", () => {
    expect(canMountJarvisVoiceReporter(null)).toBe(false);
    expect(
      canMountJarvisVoiceReporter({ authenticated: true, scopes: ["orchestration:read"] }),
    ).toBe(false);
    expect(
      canMountJarvisVoiceReporter({ authenticated: true, scopes: ["orchestration:operate"] }),
    ).toBe(true);
  });

  it("uses local FIFO and bounded in-memory dedupe without delivery state", async () => {
    const ids = new Set<string>();
    expect(rememberBoundedPresentationId(ids, "one", 1)).toBe(true);
    expect(rememberBoundedPresentationId(ids, "one", 1)).toBe(false);
    expect(rememberBoundedPresentationId(ids, "two", 1)).toBe(true);
    expect(ids.has("one")).toBe(false);
    expect(ids.has("two")).toBe(true);

    const order: string[] = [];
    let queue = Promise.resolve();
    queue = enqueueJarvisPresentation(queue, async () => {
      order.push("first");
    });
    queue = enqueueJarvisPresentation(queue, async () => {
      order.push("second");
    });
    await queue;
    expect(order).toEqual(["first", "second"]);
  });

  it("keeps speech copy and UI attention specific to the presentation kind", () => {
    expect(spokenPresentationText(event("completed"))).toBe("The requested task is complete.");
    expect(spokenPresentationText(event("approval-needed"))).toContain("Quick check");
    expect(presentationStatus(event("waiting-for-input"))).toMatchObject({
      state: "I need your input",
      kind: "attention",
    });
    expect(presentationStatus(event("failed"))).toMatchObject({
      state: "I hit a snag",
      kind: "error",
    });
  });
});
