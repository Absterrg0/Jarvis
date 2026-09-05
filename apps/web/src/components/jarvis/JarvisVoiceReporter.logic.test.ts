import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type JarvisPresentationEvent,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  canMountJarvisVoiceReporter,
  createJarvisSpeechPlaybackQueue,
  enqueueJarvisPresentation,
  presentationStatus,
  rememberBoundedPresentationId,
  spokenPresentationText,
} from "./JarvisVoiceReporter.logic";

const namedEvent = (presentationId: string): JarvisPresentationEvent => ({
  ...event("completed"),
  presentationId,
});

const event = (kind: JarvisPresentationEvent["kind"]): JarvisPresentationEvent => ({
  presentationId: `presentation-${kind}`,
  projectId: ProjectId.make("project-voice"),
  threadId: ThreadId.make("thread-voice"),
  taskRef: {
    executionNodeId: EnvironmentId.make("node-execution"),
    threadId: ThreadId.make("thread-voice"),
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

  it("speaks queued reports in order and drops the oldest past the bound", async () => {
    const spoken: string[] = [];
    const queue = createJarvisSpeechPlaybackQueue({
      speak: async (presentation) => {
        spoken.push(presentation.presentationId);
        return { status: "played" };
      },
      cancel: () => undefined,
      maxPending: 2,
    });
    queue.enqueue(namedEvent("one"));
    queue.enqueue(namedEvent("two"));
    queue.enqueue(namedEvent("three"));
    queue.enqueue(namedEvent("four"));
    // The in-flight report is never dropped; overflow sheds the oldest
    // waiting report ("two") so newer results win the bound.
    await vi.waitFor(() => expect(spoken).toEqual(["one", "three", "four"]));
    expect(queue.size()).toBe(0);
  });

  it("clears obsolete work and cancels in-flight speech on disconnect", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const spoken: string[] = [];
    const cancelled: string[] = [];
    let deliver = true;
    const failures: string[] = [];
    const queue = createJarvisSpeechPlaybackQueue({
      speak: (presentation) => {
        spoken.push(presentation.presentationId);
        if (presentation.presentationId === "first")
          return firstStarted.then(() => ({ status: "played" as const }));
        return Promise.resolve({ status: "played" as const });
      },
      cancel: (presentation) => {
        cancelled.push(presentation.presentationId);
      },
      shouldDeliver: () => deliver,
      onDeliveryFailure: () => {
        failures.push("failed");
      },
    });
    queue.enqueue(namedEvent("first"));
    await vi.waitFor(() => expect(spoken).toEqual(["first"]));
    queue.enqueue(namedEvent("second"));
    deliver = false;
    queue.clear();
    releaseFirst?.();
    await vi.waitFor(() => expect(cancelled).toEqual(["first"]));
    // The stale second report never speaks, and the muted first playback
    // reports no failure after the generation moved on.
    expect(spoken).toEqual(["first"]);
    expect(failures).toEqual([]);
    expect(queue.size()).toBe(0);
  });

  it("reports a failed delivery without stalling later reports", async () => {
    const spoken: string[] = [];
    const failures: string[] = [];
    const queue = createJarvisSpeechPlaybackQueue({
      speak: async (presentation) => {
        spoken.push(presentation.presentationId);
        return presentation.presentationId === "bad"
          ? { status: "failed", code: "browser-speech-failed" }
          : { status: "played" };
      },
      cancel: () => undefined,
      onDeliveryFailure: () => {
        failures.push("failed");
      },
    });
    queue.enqueue(namedEvent("bad"));
    queue.enqueue(namedEvent("good"));
    await vi.waitFor(() => expect(spoken).toEqual(["bad", "good"]));
    expect(failures).toEqual(["failed"]);
  });
});
