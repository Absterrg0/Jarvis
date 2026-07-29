import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useMessageQueueStore } from "./messageQueueStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("local"),
  ThreadId.make("thread-message-queue"),
);

const queuedMessage = (id: string, prompt: string) => ({
  id,
  createdAt: "2026-07-30T10:00:00.000Z",
  prompt,
  images: [],
  terminalContexts: [],
  elementContexts: [],
  previewAnnotations: [],
  reviewComments: [],
});

describe("messageQueueStore", () => {
  it("keeps messages ordered per thread and only removes the head when dequeued", () => {
    const store = useMessageQueueStore.getState();
    store.clearAll();

    store.enqueue(threadRef, queuedMessage("first", "Run tests"));
    store.enqueue(threadRef, queuedMessage("second", "Fix the failures"));

    expect(
      useMessageQueueStore
        .getState()
        .messagesForThread(threadRef)
        .map((item) => item.id),
    ).toEqual(["first", "second"]);
    expect(useMessageQueueStore.getState().peek(threadRef)?.id).toBe("first");
    expect(useMessageQueueStore.getState().dequeue(threadRef)?.id).toBe("first");
    expect(
      useMessageQueueStore
        .getState()
        .messagesForThread(threadRef)
        .map((item) => item.id),
    ).toEqual(["second"]);
  });

  it("allows a queued message to be removed before it runs", () => {
    const store = useMessageQueueStore.getState();
    store.clearAll();
    store.enqueue(threadRef, queuedMessage("keep", "Keep me"));
    store.enqueue(threadRef, queuedMessage("remove", "Remove me"));

    store.remove(threadRef, "remove");

    expect(
      useMessageQueueStore
        .getState()
        .messagesForThread(threadRef)
        .map((item) => item.id),
    ).toEqual(["keep"]);
  });
});
