import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type JarvisTaskDeskState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { executeWithTaskDesk } from "./executeWithTaskDesk.ts";
import { JarvisTaskDesk } from "./Services/JarvisTaskDesk.ts";
import type { JarvisTaskDeskShape } from "./Services/JarvisTaskDesk.ts";

const sessionId = AuthSessionId.make("session-one");
const projectId = ProjectId.make("project-one");
const task = {
  threadId: ThreadId.make("thread-one"),
  projectRef: { nodeId: EnvironmentId.make("node-one"), projectId },
};
const desk = (overrides: Partial<JarvisTaskDeskState> = {}): JarvisTaskDeskState => ({
  focusedTask: null,
  recentTasks: [],
  pendingInteraction: null,
  updatedAt: null,
  ...overrides,
});

it.effect("focuses a task and keeps identity scoped to the session", () => {
  const calls: Array<unknown> = [];
  const taskDesk: JarvisTaskDeskShape = {
    get: () => Effect.succeed(desk({ recentTasks: [task] })),
    focus: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return desk({ focusedTask: input.task, recentTasks: [input.task] });
      }),
    navigate: ({ navigation }) => {
      const focusedTask = navigation.action === "focus" ? task : null;
      return Effect.sync(() => {
        if (focusedTask !== null) calls.push(focusedTask);
        return desk({ focusedTask, recentTasks: focusedTask === null ? [] : [focusedTask] });
      });
    },
    setPendingInteraction: () => Effect.succeed(desk()),
    consumePendingInteraction: () => Effect.succeed(null),
    clearPendingInteraction: () => Effect.succeed(desk()),
  };
  const manager = {
    execute: () =>
      Effect.succeed({
        status: "started" as const,
        threadId: ThreadId.make("thread-two"),
        projectId,
        objective: "new work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
      }),
  };
  return executeWithTaskDesk(manager, taskDesk, sessionId, {
    projectId,
    utterance: "switch to thread-one task",
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        assert.equal(result.status, "acknowledged");
        assert.equal(calls.length, 1);
      }),
    ),
  );
});

it.effect("persists one pending task clarification and resolves its ordinal", () => {
  let current = desk({ recentTasks: [task, { ...task, threadId: ThreadId.make("thread-two") }] });
  const taskDesk: JarvisTaskDeskShape = {
    get: () => Effect.succeed(current),
    focus: ({ task: focusedTask }) =>
      Effect.sync(() => (current = desk({ focusedTask, recentTasks: [focusedTask] }))),
    navigate: () => Effect.succeed(current),
    setPendingInteraction: ({ interaction }) =>
      Effect.sync(() => (current = desk({ pendingInteraction: interaction }))),
    consumePendingInteraction: () => Effect.succeed(null),
    clearPendingInteraction: () => Effect.sync(() => (current = desk())),
  };
  const manager = {
    execute: () =>
      Effect.succeed({
        status: "started" as const,
        threadId: ThreadId.make("thread-new"),
        projectId,
        objective: "new work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
      }),
  };
  return executeWithTaskDesk(manager, taskDesk, sessionId, {
    projectId,
    utterance: "switch to the review task",
  }).pipe(
    Effect.flatMap(() =>
      Effect.sync(() => {
        assert.equal(current.pendingInteraction?.kind, "task");
      }),
    ),
  );
});
