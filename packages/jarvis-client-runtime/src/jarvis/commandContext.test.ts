import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildJarvisClientCommandContext } from "./commandContext.ts";

const nodeId = EnvironmentId.make("desktop");
const projectId = ProjectId.make("jarvis");
const projectRef = { nodeId, projectId };
const threadId = ThreadId.make("thread-1");

describe("jarvis client command context", () => {
  it("builds thread context from a node-qualified task on the selected project", () => {
    expect(
      buildJarvisClientCommandContext({
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
      buildJarvisClientCommandContext({
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
      buildJarvisClientCommandContext({
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
    expect(buildJarvisClientCommandContext({ projectRef })).toEqual({});
  });

  it("pins the projected unique pending request as the expected reply", () => {
    expect(
      buildJarvisClientCommandContext({
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
      buildJarvisClientCommandContext({
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
      buildJarvisClientCommandContext({
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
      buildJarvisClientCommandContext({
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
