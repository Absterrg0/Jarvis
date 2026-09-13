import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCirceClientCommandContext,
  isSameCirceReplyPin,
  resolveCirceLiveContextTask,
} from "./commandContext.ts";

const nodeId = EnvironmentId.make("desktop");
const projectId = ProjectId.make("circe");
const projectRef = { nodeId, projectId };
const threadId = ThreadId.make("thread-1");

describe("circe client command context", () => {
  it("builds thread context from a node-qualified task on the selected project", () => {
    expect(
      buildCirceClientCommandContext({
        projectRef,
        task: {
          threadId,
          taskRef: { executionNodeId: nodeId, threadId },
          projectRef,
        },
      }),
    ).toEqual({ contextThreadId: threadId, referenceThreadId: threadId });
  });

  it("yields no context when task project and selection disagree", () => {
    expect(
      buildCirceClientCommandContext({
        projectRef,
        task: {
          threadId,
          taskRef: { executionNodeId: nodeId, threadId },
          projectRef: { nodeId, projectId: ProjectId.make("other") },
        },
      }),
    ).toEqual({});
  });

  it("yields no context when taskRef disagrees with projectRef", () => {
    expect(
      buildCirceClientCommandContext({
        projectRef,
        task: {
          threadId,
          taskRef: {
            executionNodeId: EnvironmentId.make("remote"),
            threadId,
          },
          projectRef,
        },
      }),
    ).toEqual({});
  });

  it("yields no context without a task", () => {
    expect(buildCirceClientCommandContext({ projectRef })).toEqual({});
  });

  describe("isSameCirceReplyPin", () => {
    it("matches pins only by kind and request identity", () => {
      const pin = { kind: "approval" as const, requestId: "req-1" };
      expect(isSameCirceReplyPin(pin, { kind: "approval", requestId: "req-1" })).toBe(true);
      expect(isSameCirceReplyPin(pin, { kind: "approval", requestId: "req-2" })).toBe(false);
      expect(isSameCirceReplyPin(pin, { kind: "user-input", requestId: "req-1" })).toBe(false);
      expect(isSameCirceReplyPin(pin, null)).toBe(false);
      expect(isSameCirceReplyPin(null, null)).toBe(true);
      expect(isSameCirceReplyPin(pin, undefined)).toBe(false);
      expect(isSameCirceReplyPin(undefined, undefined)).toBe(true);
      expect(isSameCirceReplyPin(undefined, null)).toBe(false);
    });
  });

  describe("resolveCirceLiveContextTask", () => {
    const selected = {
      threadId,
      taskRef: { executionNodeId: nodeId, threadId },
      projectRef,
      pendingReply: null as null,
    };

    it("merges the live pin for the exact task identity", () => {
      expect(
        resolveCirceLiveContextTask({
          selected,
          deskTasks: [
            {
              threadId,
              taskRef: { executionNodeId: nodeId, threadId },
              projectRef,
              pendingReply: { kind: "approval" as const, requestId: "req-live" },
            },
          ],
        }),
      ).toEqual({
        ...selected,
        pendingReply: { kind: "approval", requestId: "req-live" },
      });
    });

    it("clears the pin only on a present entry with an explicit null", () => {
      expect(
        resolveCirceLiveContextTask({
          selected: {
            ...selected,
            pendingReply: { kind: "approval" as const, requestId: "req-old" },
          },
          deskTasks: [{ threadId, taskRef: selected.taskRef, projectRef, pendingReply: null }],
        }),
      ).toEqual({ ...selected, pendingReply: null });
    });

    it("never merges an identical thread identifier from another node", () => {
      const otherNode = EnvironmentId.make("remote");
      expect(
        resolveCirceLiveContextTask({
          selected,
          deskTasks: [
            {
              threadId,
              taskRef: { executionNodeId: otherNode, threadId },
              projectRef: { nodeId: otherNode, projectId },
              pendingReply: { kind: "approval" as const, requestId: "req-other" },
            },
          ],
        }),
      ).toBe(selected);
    });

    it("keeps the retained pin when the task is absent or its pin is unknown", () => {
      const pinned = {
        ...selected,
        pendingReply: { kind: "approval" as const, requestId: "req-old" },
      };
      expect(resolveCirceLiveContextTask({ selected: pinned, deskTasks: [] })).toBe(pinned);
      expect(
        resolveCirceLiveContextTask({
          selected: pinned,
          deskTasks: [{ threadId, taskRef: selected.taskRef, projectRef }],
        }),
      ).toBe(pinned);
    });

    it("leaves explicit project-only and unknown selections alone", () => {
      expect(resolveCirceLiveContextTask({ selected: null, deskTasks: [] })).toBeNull();
      expect(resolveCirceLiveContextTask({ deskTasks: [] })).toBeUndefined();
    });
  });

  it("pins the projected unique pending request as the expected reply", () => {
    expect(
      buildCirceClientCommandContext({
        projectRef,
        task: {
          threadId,
          taskRef: { executionNodeId: nodeId, threadId },
          projectRef,
          pendingReply: { kind: "approval", requestId: "request-1" },
        },
      }),
    ).toEqual({
      contextThreadId: threadId,
      referenceThreadId: threadId,
      expectedReply: { kind: "approval", requestId: "request-1" },
    });
    expect(
      buildCirceClientCommandContext({
        projectRef,
        task: {
          threadId,
          taskRef: { executionNodeId: nodeId, threadId },
          projectRef,
          pendingReply: { kind: "user-input", requestId: "input-1", questionIds: ["q1"] },
        },
      }),
    ).toMatchObject({ expectedReply: { kind: "input", requestId: "input-1" } });
  });

  it("pins explicit null when the snapshot saw no unique pending request", () => {
    expect(
      buildCirceClientCommandContext({
        projectRef,
        task: {
          threadId,
          taskRef: { executionNodeId: nodeId, threadId },
          projectRef,
          pendingReply: null,
        },
      }),
    ).toEqual({
      contextThreadId: threadId,
      referenceThreadId: threadId,
      expectedReply: null,
    });
  });

  it("drops the pin when the task identity disagrees with the selection", () => {
    expect(
      buildCirceClientCommandContext({
        projectRef,
        task: {
          threadId,
          taskRef: { executionNodeId: nodeId, threadId },
          projectRef: { nodeId, projectId: ProjectId.make("other") },
          pendingReply: { kind: "approval", requestId: "request-1" },
        },
      }),
    ).toEqual({});
  });
});
