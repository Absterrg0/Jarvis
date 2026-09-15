import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { circePlanTargetOutcomes } from "./planPresentation.ts";

const fallbackProjectRef = {
  nodeId: EnvironmentId.make("node-1"),
  projectId: ProjectId.make("project-1"),
};

describe("circe plan target outcomes", () => {
  it("adopts the exact node-qualified task a focus step named", () => {
    expect(
      circePlanTargetOutcomes(
        [
          {
            action: "focused",
            status: "acknowledged",
            message: "Switched to the task.",
            projectId: ProjectId.make("project-2"),
            taskRef: {
              executionNodeId: EnvironmentId.make("node-2"),
              threadId: ThreadId.make("thread-1"),
            },
          },
        ],
        fallbackProjectRef,
      ),
    ).toEqual([
      {
        kind: "task",
        projectRef: {
          nodeId: EnvironmentId.make("node-2"),
          projectId: ProjectId.make("project-2"),
        },
        taskRef: {
          executionNodeId: EnvironmentId.make("node-2"),
          threadId: ThreadId.make("thread-1"),
        },
      },
    ]);
  });

  it("keeps a project-only focus project-scoped with no task pin", () => {
    expect(
      circePlanTargetOutcomes(
        [
          {
            action: "focused",
            status: "acknowledged",
            message: "Switched to Beacon.",
            projectId: ProjectId.make("project-2"),
          },
        ],
        fallbackProjectRef,
      ),
    ).toEqual([
      {
        kind: "project",
        projectRef: {
          nodeId: EnvironmentId.make("node-1"),
          projectId: ProjectId.make("project-2"),
        },
      },
    ]);
  });

  it("pins every started step in order and lets later outcomes win", () => {
    expect(
      circePlanTargetOutcomes(
        [
          {
            action: "focused",
            status: "acknowledged",
            message: "Switched to Beacon.",
            projectId: ProjectId.make("project-2"),
          },
          {
            action: "start",
            status: "started",
            message: "Started the task.",
            threadId: ThreadId.make("thread-9"),
            projectId: ProjectId.make("project-2"),
            taskRef: {
              executionNodeId: EnvironmentId.make("node-2"),
              threadId: ThreadId.make("thread-9"),
            },
          },
        ],
        fallbackProjectRef,
      ),
    ).toEqual([
      {
        kind: "project",
        projectRef: {
          nodeId: EnvironmentId.make("node-1"),
          projectId: ProjectId.make("project-2"),
        },
      },
      {
        kind: "start",
        projectRef: {
          nodeId: EnvironmentId.make("node-2"),
          projectId: ProjectId.make("project-2"),
        },
        taskRef: {
          executionNodeId: EnvironmentId.make("node-2"),
          threadId: ThreadId.make("thread-9"),
        },
        threadId: ThreadId.make("thread-9"),
      },
    ]);
  });

  it("synthesizes a same-node task ref when a started step lacks one", () => {
    expect(
      circePlanTargetOutcomes(
        [
          {
            action: "start",
            status: "started",
            message: "Started the task.",
            threadId: ThreadId.make("thread-9"),
          },
        ],
        fallbackProjectRef,
      ),
    ).toEqual([
      {
        kind: "start",
        projectRef: {
          nodeId: EnvironmentId.make("node-1"),
          projectId: ProjectId.make("project-1"),
        },
        taskRef: {
          executionNodeId: EnvironmentId.make("node-1"),
          threadId: ThreadId.make("thread-9"),
        },
        threadId: ThreadId.make("thread-9"),
      },
    ]);
  });

  it("ignores a focused step that never acknowledged", () => {
    expect(
      circePlanTargetOutcomes(
        [
          {
            action: "focused",
            status: "failed",
            message: "Focus failed.",
            projectId: ProjectId.make("project-2"),
          },
          {
            action: "focused",
            status: "needs-input",
            message: "Which task?",
            projectId: ProjectId.make("project-2"),
          },
        ],
        fallbackProjectRef,
      ),
    ).toEqual([]);
  });
});
