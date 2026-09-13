import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
  type CircePresentationEvent,
} from "@t3tools/contracts";
import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

import {
  browserSpeechQueueSize,
  cancelBrowserSpeech,
  canMountCirceVoiceReporter,
  cancelCirceSpeechDelivery,
  createCirceSpeechPlaybackQueue,
  enqueueBrowserSpeech,
  enqueueCircePresentation,
  isCirceSpeechRequestStale,
  isCirceSpeechTurnTerminal,
  noteCirceSpeechRequestTurn,
  noteCirceSpeechTerminal,
  presentationStatus,
  rememberBoundedPresentationId,
  resetCirceSpeechRelevanceForTests,
  spokenPresentationText,
} from "./CirceVoiceReporter.logic";

const namedEvent = (presentationId: string): CircePresentationEvent => ({
  ...event("completed"),
  presentationId,
});

const turnedEvent = (
  presentationId: string,
  kind: CircePresentationEvent["kind"],
  turnId: string,
): CircePresentationEvent => ({
  ...event(kind),
  presentationId,
  turnId: turnId as never,
});

const event = (kind: CircePresentationEvent["kind"]): CircePresentationEvent => ({
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

describe("Circe live voice presentation", () => {
  beforeEach(() => {
    resetCirceSpeechRelevanceForTests();
  });

  it("mounts only for authenticated clients with operation scope", () => {
    expect(canMountCirceVoiceReporter(null)).toBe(false);
    expect(
      canMountCirceVoiceReporter({ authenticated: true, scopes: ["orchestration:read"] }),
    ).toBe(false);
    expect(
      canMountCirceVoiceReporter({ authenticated: true, scopes: ["orchestration:operate"] }),
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
    queue = enqueueCircePresentation(queue, async () => {
      order.push("first");
    });
    queue = enqueueCircePresentation(queue, async () => {
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
    const queue = createCirceSpeechPlaybackQueue({
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
    const queue = createCirceSpeechPlaybackQueue({
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
    const queue = createCirceSpeechPlaybackQueue({
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

  it("releases a never-settling playback on clear so later reports start", async () => {
    const spoken: string[] = [];
    const cancelled: string[] = [];
    const failures: string[] = [];
    const queue = createCirceSpeechPlaybackQueue({
      speak: (presentation) => {
        spoken.push(presentation.presentationId);
        // The first playback never settles: no end event, no error, no
        // worker timeout. Only clear() may release it.
        if (presentation.presentationId === "stuck") return new Promise(() => undefined);
        return Promise.resolve({ status: "played" as const });
      },
      cancel: (presentation) => {
        cancelled.push(presentation.presentationId);
      },
      onDeliveryFailure: () => {
        failures.push("failed");
      },
    });
    queue.enqueue(namedEvent("stuck"));
    await vi.waitFor(() => expect(spoken).toEqual(["stuck"]));
    queue.enqueue(namedEvent("obsolete"));
    queue.clear();
    // The stuck playback is cancelled and muted; the obsolete report never
    // speaks and reports no failure.
    expect(cancelled).toEqual(["stuck"]);
    expect(queue.size()).toBe(0);
    queue.enqueue(namedEvent("later"));
    await vi.waitFor(() => expect(spoken).toEqual(["stuck", "later"]));
    expect(failures).toEqual([]);
    expect(queue.size()).toBe(0);
  });

  it("drops a prompt arriving after its turn terminal, independent of order", async () => {
    const spoken: string[] = [];
    const queue = createCirceSpeechPlaybackQueue({
      speak: async (presentation) => {
        spoken.push(presentation.presentationId);
        return { status: "played" };
      },
      cancel: () => undefined,
    });
    queue.enqueue(turnedEvent("terminal-9", "completed", "turn-1"));
    queue.enqueue(turnedEvent("prompt-1", "waiting-for-input", "turn-1"));
    await vi.waitFor(() => expect(spoken).toEqual(["terminal-9"]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spoken).toEqual(["terminal-9"]);
    expect(queue.size()).toBe(0);
  });

  it("retires a queued prompt when its turn terminal arrives", async () => {
    let releasePrompt!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const spoken: string[] = [];
    const cancelled: string[] = [];
    const queue = createCirceSpeechPlaybackQueue({
      speak: (presentation) => {
        spoken.push(presentation.presentationId);
        if (presentation.presentationId === "prompt-1")
          return promptStarted.then(() => ({ status: "played" as const }));
        return Promise.resolve({ status: "played" as const });
      },
      cancel: (presentation) => {
        cancelled.push(presentation.presentationId);
      },
    });
    queue.enqueue(turnedEvent("prompt-1", "waiting-for-input", "turn-1"));
    await vi.waitFor(() => expect(spoken).toEqual(["prompt-1"]));
    queue.enqueue(turnedEvent("terminal-9", "completed", "turn-1"));
    await vi.waitFor(() => expect(cancelled).toEqual(["prompt-1"]));
    releasePrompt();
    await vi.waitFor(() => expect(spoken).toEqual(["prompt-1", "terminal-9"]));
    expect(queue.size()).toBe(0);
  });

  it("allows a later legitimate turn on the same task after its terminal", async () => {
    const spoken: string[] = [];
    const queue = createCirceSpeechPlaybackQueue({
      speak: async (presentation) => {
        spoken.push(presentation.presentationId);
        return { status: "played" };
      },
      cancel: () => undefined,
    });
    queue.enqueue(turnedEvent("terminal-9", "completed", "turn-1"));
    queue.enqueue(turnedEvent("terminal-10", "completed", "turn-2"));
    await vi.waitFor(() => expect(spoken).toEqual(["terminal-9", "terminal-10"]));
    expect(queue.size()).toBe(0);
  });

  it("drops a prompt by scoped requestId while keeping an unrelated origin", async () => {
    const spoken: string[] = [];
    const queue = createCirceSpeechPlaybackQueue({
      speak: async (presentation) => {
        spoken.push(presentation.presentationId);
        return { status: "played" };
      },
      cancel: () => undefined,
    });
    queue.enqueue({
      ...event("completed"),
      presentationId: "terminal-request-1",
      requestId: "request-1",
    });
    queue.enqueue({
      ...event("waiting-for-input"),
      presentationId: "prompt-1",
      requestId: "request-1",
    });
    queue.enqueue({
      ...event("waiting-for-input"),
      presentationId: "prompt-2",
      requestId: "request-2",
    });
    await vi.waitFor(() => expect(spoken).toContain("terminal-request-1"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spoken).toContain("prompt-2");
    expect(spoken).not.toContain("prompt-1");
  });

  it("vetoes a delayed interaction ack once its turn terminal is noted", () => {
    const threadId = ThreadId.make("thread-voice");
    const turnId = TurnId.make("turn-1");
    const taskRef = {
      executionNodeId: EnvironmentId.make("node-execution"),
      threadId,
    } as never;
    expect(isCirceSpeechRequestStale({ threadId, taskRef, turnId, requestId: "request-1" })).toBe(
      false,
    );
    noteCirceSpeechTerminal({ threadId, taskRef, turnId });
    expect(isCirceSpeechTurnTerminal({ threadId, taskRef, turnId })).toBe(true);
    expect(isCirceSpeechRequestStale({ threadId, taskRef, turnId, requestId: "request-1" })).toBe(
      true,
    );
    expect(
      isCirceSpeechRequestStale({
        threadId,
        taskRef,
        turnId: TurnId.make("turn-2"),
        requestId: "request-2",
      }),
    ).toBe(false);
  });

  it("links a turn-less prompt to its terminal through the accepted request", () => {
    const threadId = ThreadId.make("thread-voice");
    const turnId = TurnId.make("turn-1");
    const taskRef = {
      executionNodeId: EnvironmentId.make("node-execution"),
      threadId,
    } as never;
    expect(isCirceSpeechRequestStale({ requestId: "request-1" })).toBe(false);
    noteCirceSpeechRequestTurn("request-1", { threadId, taskRef, turnId });
    noteCirceSpeechTerminal({ threadId, taskRef, turnId });
    expect(isCirceSpeechRequestStale({ requestId: "request-1" })).toBe(true);
    expect(isCirceSpeechRequestStale({ requestId: "request-2" })).toBe(false);
  });

  it("vetoes a delayed ack by scoped requestId when its terminal arrived first", () => {
    const threadId = ThreadId.make("thread-voice");
    const taskRef = {
      executionNodeId: EnvironmentId.make("node-execution"),
      threadId,
    } as never;
    expect(isCirceSpeechRequestStale({ threadId, taskRef, requestId: "request-1" })).toBe(false);
    noteCirceSpeechTerminal({ threadId, taskRef, requestId: "request-1" });
    expect(isCirceSpeechRequestStale({ threadId, taskRef, requestId: "request-1" })).toBe(true);
    expect(isCirceSpeechRequestStale({ threadId, taskRef, requestId: "request-2" })).toBe(false);
  });

  it("keeps a later unrelated request on the same task speakable", () => {
    const threadId = ThreadId.make("thread-voice");
    const taskRef = {
      executionNodeId: EnvironmentId.make("node-execution"),
      threadId,
    } as never;
    noteCirceSpeechTerminal({ threadId, taskRef, requestId: "request-1" });
    expect(isCirceSpeechRequestStale({ threadId, taskRef, requestId: "request-2" })).toBe(false);
    expect(
      isCirceSpeechRequestStale({
        threadId,
        taskRef,
        turnId: TurnId.make("turn-2"),
        requestId: "request-2",
      }),
    ).toBe(false);
  });

  it("scopes a request terminal to its own node and thread", () => {
    const threadId = ThreadId.make("thread-voice");
    const taskRef = {
      executionNodeId: EnvironmentId.make("node-execution"),
      threadId,
    } as never;
    noteCirceSpeechTerminal({ threadId, taskRef, requestId: "request-shared" });
    expect(
      isCirceSpeechRequestStale({
        threadId: ThreadId.make("other-thread"),
        taskRef: {
          executionNodeId: EnvironmentId.make("node-execution"),
          threadId: ThreadId.make("other-thread"),
        } as never,
        requestId: "request-shared",
      }),
    ).toBe(false);
  });

  it("reports terminal taskRef, threadId, and turnId without a delivery ledger", async () => {
    const notices: Array<{ readonly presentationId: string }> = [];
    const seen: string[] = [];
    const queue = createCirceSpeechPlaybackQueue({
      speak: async (presentation) => {
        seen.push(presentation.presentationId);
        return { status: "played" };
      },
      cancel: () => undefined,
      onTerminal: (notice) => {
        notices.push({
          presentationId: `${notice.threadId}:${notice.turnId}`,
        });
        expect(notice.taskRef?.executionNodeId).toBe("node-execution");
        expect(notice.threadId).toBe("thread-voice");
      },
    });
    queue.enqueue(turnedEvent("prompt-1", "waiting-for-input", "turn-7"));
    queue.enqueue(turnedEvent("terminal-7", "completed", "turn-7"));
    await vi.waitFor(() => expect(seen).toContain("terminal-7"));
    expect(notices).toHaveLength(1);
    expect(queue.size()).toBe(0);
  });

  it("delivers terminal taskRef and turnId over the speech bus with no ledger", async () => {
    const { onCirceSpeechTerminal, publishCirceSpeechTerminal, resetCirceCommandBusForTests } =
      await import("../../circeBus");
    resetCirceCommandBusForTests();
    try {
      const received: Array<{ readonly turnId: unknown }> = [];
      const release = onCirceSpeechTerminal((event) => {
        received.push({ turnId: event.turnId });
        expect(event.threadId).toBe("thread-voice");
        expect(event.taskRef?.executionNodeId).toBe("node-execution");
      });
      publishCirceSpeechTerminal({
        threadId: ThreadId.make("thread-voice"),
        taskRef: {
          executionNodeId: EnvironmentId.make("node-execution"),
          threadId: ThreadId.make("thread-voice"),
        },
        turnId: TurnId.make("turn-9"),
      });
      expect(received).toHaveLength(1);
      release();
      publishCirceSpeechTerminal({
        threadId: ThreadId.make("thread-voice"),
        turnId: TurnId.make("turn-10"),
      });
      expect(received).toHaveLength(1);
    } finally {
      resetCirceCommandBusForTests();
      resetCirceSpeechRelevanceForTests();
    }
  });

  describe("shared browser speech lane", () => {
    function stubBrowserSpeech() {
      const speak = vi.fn();
      const cancel = vi.fn();
      const instances: Array<{
        readonly text: string;
        fire: (type: "end" | "error") => void;
      }> = [];
      class FakeUtterance {
        lang = "";
        rate = 1;
        private readonly listeners = new Map<string, Array<() => void>>();
        constructor(readonly text: string) {}
        addEventListener(type: string, handler: () => void): void {
          const list = this.listeners.get(type) ?? [];
          list.push(handler);
          this.listeners.set(type, list);
        }
        fire(type: "end" | "error"): void {
          for (const handler of this.listeners.get(type) ?? []) handler();
        }
      }
      const holder = globalThis as { window?: unknown };
      const previous = holder.window;
      holder.window = {
        speechSynthesis: {
          speak: (utterance: FakeUtterance) => {
            instances.push({
              text: utterance.text,
              fire: (type) => utterance.fire(type),
            });
            speak(utterance.text);
          },
          cancel,
        },
        SpeechSynthesisUtterance: FakeUtterance,
      };
      return {
        speak,
        cancel,
        spokenTexts: () => instances.map((instance) => instance.text),
        fire: (type: "end" | "error", index: number) => instances[index]?.fire(type),
        restore: () => {
          holder.window = previous;
        },
      };
    }

    it("drops a disconnected node's waiting utterance instead of speaking it", async () => {
      const browser = stubBrowserSpeech();
      try {
        // A speaks live while B waits in the lane: only A reaches the
        // browser singleton, so nothing is natively queued behind it.
        const a = enqueueBrowserSpeech("a text", "delivery-a");
        const b = enqueueBrowserSpeech("b text", "delivery-b");
        await vi.waitFor(() => expect(browser.speak).toHaveBeenCalledTimes(1));
        expect(browser.spokenTexts()).toEqual(["a text"]);
        cancelBrowserSpeech("delivery-b");
        await expect(b).resolves.toEqual({ status: "deferred", reason: "cancelled" });
        browser.fire("end", 0);
        await expect(a).resolves.toEqual({ status: "played" });
        expect(browser.speak).toHaveBeenCalledTimes(1);
        expect(browserSpeechQueueSize()).toBe(0);
      } finally {
        browser.restore();
      }
    });

    it("lets another node's disconnect through without killing live speech", async () => {
      const browser = stubBrowserSpeech();
      try {
        const a = enqueueBrowserSpeech("a text", "delivery-a");
        cancelBrowserSpeech("delivery-b");
        expect(browser.cancel).not.toHaveBeenCalled();
        browser.fire("end", 0);
        await expect(a).resolves.toEqual({ status: "played" });
        expect(browserSpeechQueueSize()).toBe(0);
      } finally {
        browser.restore();
      }
    });

    it("advances the lane when the live utterance is cancelled", async () => {
      const browser = stubBrowserSpeech();
      try {
        const a = enqueueBrowserSpeech("a text", "delivery-a");
        const b = enqueueBrowserSpeech("b text", "delivery-b");
        await vi.waitFor(() => expect(browser.speak).toHaveBeenCalledTimes(1));
        cancelBrowserSpeech("delivery-a");
        await expect(a).resolves.toEqual({ status: "deferred", reason: "cancelled" });
        expect(browser.cancel).toHaveBeenCalledTimes(1);
        // Ownership transferred: B starts on its own without another call.
        await vi.waitFor(() => expect(browser.speak).toHaveBeenCalledTimes(2));
        expect(browser.spokenTexts()).toEqual(["a text", "b text"]);
        browser.fire("end", 1);
        await expect(b).resolves.toEqual({ status: "played" });
        expect(browserSpeechQueueSize()).toBe(0);
      } finally {
        browser.restore();
      }
    });

    it("reports failure and advances when the utterance errors", async () => {
      const browser = stubBrowserSpeech();
      try {
        const a = enqueueBrowserSpeech("a text", "delivery-a");
        const b = enqueueBrowserSpeech("b text", "delivery-b");
        await vi.waitFor(() => expect(browser.speak).toHaveBeenCalledTimes(1));
        browser.fire("error", 0);
        await expect(a).resolves.toEqual({ status: "failed", code: "browser-speech-failed" });
        await vi.waitFor(() => expect(browser.speak).toHaveBeenCalledTimes(2));
        browser.fire("end", 1);
        await expect(b).resolves.toEqual({ status: "played" });
        expect(browserSpeechQueueSize()).toBe(0);
      } finally {
        browser.restore();
      }
    });

    it("fails fast without a browser speech service", async () => {
      await expect(enqueueBrowserSpeech("hello", "delivery-unsupported")).resolves.toEqual({
        status: "failed",
        code: "speech-unavailable",
      });
      expect(browserSpeechQueueSize()).toBe(0);
    });

    it("keeps per-node queues from reaching the speaker after a disconnect", async () => {
      const browser = stubBrowserSpeech();
      try {
        const nodeQueue = () =>
          createCirceSpeechPlaybackQueue({
            speak: (presentation) =>
              enqueueBrowserSpeech(
                `text ${presentation.presentationId}`,
                presentation.presentationId,
              ),
            cancel: (presentation) => cancelCirceSpeechDelivery(presentation.presentationId),
          });
        const queueA = nodeQueue();
        const queueB = nodeQueue();
        queueA.enqueue(namedEvent("delivery-a"));
        await vi.waitFor(() => expect(browser.speak).toHaveBeenCalledTimes(1));
        queueB.enqueue(namedEvent("delivery-b"));
        queueB.clear();
        cancelCirceSpeechDelivery("delivery-b");
        browser.fire("end", 0);
        await vi.waitFor(() => expect(browserSpeechQueueSize()).toBe(0));
        // A played alone: B's cancelled report never reached the speaker,
        // even though both node queues share the browser singleton.
        expect(browser.spokenTexts()).toEqual(["text delivery-a"]);
        expect(browser.cancel).not.toHaveBeenCalled();
      } finally {
        browser.restore();
      }
    });
  });
});
