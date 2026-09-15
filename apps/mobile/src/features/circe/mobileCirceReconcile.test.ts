import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { retireFinishedMobileTurns, groupRetainedThreadIdsByNode } from "./mobileCirceReconcile";

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

  it("retires removed and durably missing turns but keeps unreachable states", () => {
    const offlineNode = EnvironmentId.make("node-offline");
    expect(
      retireFinishedMobileTurns({
        turns: [
          turn("removed", "thread-x", otherNode),
          turn("evicted", "thread-missing"),
          turn("unreachable", "thread-y", offlineNode),
        ],
        threads: new Map([
          [
            node,
            new Map([
              [ThreadId.make("thread-missing"), { status: "missing" as const }],
              [ThreadId.make("thread-y"), { status: "unreachable" as const }],
            ]),
          ],
          [offlineNode, new Map()],
        ]),
        desks: new Map(),
        cataloguedNodeIds: new Set([node, offlineNode]),
      }),
    ).toEqual(["removed", "evicted"]);
  });

  it("retires a terminal ordinary thread when the task desk no longer lists it", () => {
    expect(
      retireFinishedMobileTurns({
        turns: [turn("settled", "thread-settled"), turn("active", "thread-active")],
        desks: new Map([[node, []]]),
        threads: new Map([
          [
            node,
            new Map([
              [
                ThreadId.make("thread-settled"),
                {
                  status: "found" as const,
                  sessionStatus: null,
                  latestTurnState: "completed" as const,
                },
              ],
              [
                ThreadId.make("thread-active"),
                {
                  status: "found" as const,
                  sessionStatus: "idle" as const,
                  latestTurnState: "running" as const,
                },
              ],
            ]),
          ],
        ]),
        cataloguedNodeIds: new Set([node]),
      }),
    ).toEqual(["settled"]);
  });

  it("keeps a running durable turn when desk or session data is stale", () => {
    expect(
      retireFinishedMobileTurns({
        turns: [
          turn("latest-running", "thread-latest-running"),
          turn("session-running", "thread-session-running"),
        ],
        desks: new Map([
          [
            node,
            [
              { threadId: ThreadId.make("thread-latest-running"), state: "ready" },
              { threadId: ThreadId.make("thread-session-running"), state: "ready" },
            ],
          ],
        ]),
        threads: new Map([
          [
            node,
            new Map([
              [
                ThreadId.make("thread-latest-running"),
                {
                  status: "found" as const,
                  sessionStatus: "ready" as const,
                  latestTurnState: "running" as const,
                },
              ],
              [
                ThreadId.make("thread-session-running"),
                {
                  status: "found" as const,
                  sessionStatus: "running" as const,
                  latestTurnState: "completed" as const,
                },
              ],
            ]),
          ],
        ]),
        cataloguedNodeIds: new Set([node]),
      }),
    ).toEqual([]);
  });

  it("retires a compound turn only after every started task settles", () => {
    const first = ThreadId.make("thread-a");
    const second = ThreadId.make("thread-b");
    const compound = {
      originInteractionId: "compound",
      projectRef: { nodeId: node },
      taskRef: { threadId: first, executionNodeId: node },
      taskRefs: [
        { threadId: first, executionNodeId: node },
        { threadId: second, executionNodeId: node },
      ],
    };
    // One task still running keeps the whole interaction alive.
    expect(
      retireFinishedMobileTurns({
        turns: [compound],
        desks: new Map([
          [
            node,
            [
              { threadId: first, state: "ready" as const },
              { threadId: second, state: "running" as const },
            ],
          ],
        ]),
        cataloguedNodeIds: new Set([node]),
      }),
    ).toEqual([]);
    // Both terminal retires it exactly once.
    expect(
      retireFinishedMobileTurns({
        turns: [compound],
        desks: new Map([
          [
            node,
            [
              { threadId: first, state: "ready" as const },
              { threadId: second, state: "failed" as const },
            ],
          ],
        ]),
        cataloguedNodeIds: new Set([node]),
      }),
    ).toEqual(["compound"]);
  });
});

describe("groupRetainedThreadIdsByNode", () => {
  it("lists each distinct thread once per node", () => {
    expect(
      groupRetainedThreadIdsByNode([
        turn("first", "thread-a"),
        turn("retry", "thread-a"),
        turn("second", "thread-b"),
        turn("other-node", "thread-c", otherNode),
        turn("no-task"),
      ]),
    ).toEqual(
      new Map([
        [node, [ThreadId.make("thread-a"), ThreadId.make("thread-b")]],
        [otherNode, [ThreadId.make("thread-c")]],
      ]),
    );
  });

  it("groups every task of a compound turn by its own node", () => {
    const compound = {
      originInteractionId: "compound",
      projectRef: { nodeId: node },
      taskRefs: [
        { threadId: ThreadId.make("thread-a"), executionNodeId: node },
        { threadId: ThreadId.make("thread-b"), executionNodeId: otherNode },
      ],
    };
    expect(groupRetainedThreadIdsByNode([compound])).toEqual(
      new Map([
        [node, [ThreadId.make("thread-a")]],
        [otherNode, [ThreadId.make("thread-b")]],
      ]),
    );
  });
});
