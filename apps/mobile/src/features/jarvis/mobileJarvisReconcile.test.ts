import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { retireFinishedMobileTurns } from "./mobileJarvisReconcile";

const node = EnvironmentId.make("node-1");
const otherNode = EnvironmentId.make("node-2");

const turn = (id: string, threadId?: string, nodeId: EnvironmentId = node) => ({
  originInteractionId: id,
  projectRef: { nodeId },
  ...(threadId === undefined ? {} : { taskRef: { threadId: ThreadId.make(threadId) } }),
});

describe("retireFinishedMobileTurns", () => {
  it("retires terminal tasks without speaking them", () => {
    expect(
      retireFinishedMobileTurns({
        turns: [
          turn("done", "thread-done"),
          turn("failed", "thread-failed"),
          turn("stopped", "thread-stopped"),
          turn("running", "thread-running"),
          turn("waiting", "thread-waiting"),
          turn("unstarted"),
        ],
        desks: new Map([
          [
            node,
            [
              { threadId: ThreadId.make("thread-done"), state: "ready" as const },
              { threadId: ThreadId.make("thread-failed"), state: "failed" as const },
              { threadId: ThreadId.make("thread-stopped"), state: "interrupted" as const },
              { threadId: ThreadId.make("thread-running"), state: "running" as const },
              { threadId: ThreadId.make("thread-waiting"), state: "waiting-for-input" as const },
            ],
          ],
        ]),
        cataloguedNodeIds: new Set([node]),
      }),
    ).toEqual(["done", "failed", "stopped"]);
  });

  it("retires turns on removed nodes but keeps unknown states", () => {
    const offlineNode = EnvironmentId.make("node-offline");
    expect(
      retireFinishedMobileTurns({
        turns: [
          turn("removed", "thread-x", otherNode),
          turn("evicted", "thread-missing"),
          turn("unreachable", "thread-y", offlineNode),
        ],
        // Removed nodes leave the catalog; offline nodes stay catalogued
        // with no reachable desk, and evicted tasks stay ambiguous. All
        // three keep-or-retire without speaking either way.
        desks: new Map(),
        cataloguedNodeIds: new Set([node, offlineNode]),
      }),
    ).toEqual(["removed"]);
  });
});
