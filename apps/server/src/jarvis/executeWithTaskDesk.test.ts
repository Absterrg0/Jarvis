import { AuthSessionId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisManager, type JarvisManagerExecuteInput } from "./Services/JarvisManager.ts";
import { JarvisTaskDesk } from "./Services/JarvisTaskDesk.ts";
import { executeWithTaskDesk } from "./executeWithTaskDesk.ts";

it.effect("uses the authenticated session's durable focus for referential commands", () => {
  const focusedThreadId = ThreadId.make("thread-auth-review");
  const received: Array<JarvisManagerExecuteInput> = [];
  const layer = Layer.mergeAll(
    Layer.mock(JarvisTaskDesk)({
      get: () =>
        Effect.succeed({
          focusedThreadId,
          backStack: [],
          forwardStack: [],
          recentTasks: [],
          newConversationArmed: false,
          updatedAt: null,
        }),
      focus: () => Effect.die("A status request must not rewrite task focus"),
    }),
    Layer.mock(JarvisManager)({
      execute: (input) =>
        Effect.sync(() => {
          received.push(input);
          return {
            status: "acknowledged" as const,
            action: "status" as const,
            threadId: focusedThreadId,
            projectId: ProjectId.make("project-rivvl"),
            message: "Authentication review is still running.",
          };
        }),
    }),
  );

  return Effect.gen(function* () {
    const manager = yield* JarvisManager;
    const taskDesk = yield* JarvisTaskDesk;
    return yield* executeWithTaskDesk(manager, taskDesk, AuthSessionId.make("session-companion"), {
      projectId: ProjectId.make("project-rivvl"),
      referenceThreadId: ThreadId.make("thread-stale-companion-hint"),
      utterance: "What is that task doing?",
    });
  }).pipe(
    Effect.provide(layer),
    Effect.tap(() =>
      Effect.sync(() => {
        expect(received).toEqual([expect.objectContaining({ referenceThreadId: focusedThreadId })]);
      }),
    ),
  );
});

it.effect("moves durable focus to a task started by the authenticated session", () => {
  const sessionId = AuthSessionId.make("session-companion");
  const projectId = ProjectId.make("project-rivvl");
  const threadId = ThreadId.make("thread-new-review");
  const focused: Array<unknown> = [];
  const layer = Layer.mergeAll(
    Layer.mock(JarvisTaskDesk)({
      get: () =>
        Effect.succeed({
          focusedThreadId: null,
          backStack: [],
          forwardStack: [],
          recentTasks: [],
          newConversationArmed: false,
          updatedAt: null,
        }),
      focus: (input) =>
        Effect.sync(() => {
          focused.push(input);
          return {
            focusedThreadId: input.task.threadId,
            backStack: [],
            forwardStack: [],
            recentTasks: [input.task],
            newConversationArmed: false,
            updatedAt: null,
          };
        }),
    }),
    Layer.mock(JarvisManager)({
      execute: () =>
        Effect.succeed({
          status: "started" as const,
          threadId,
          objective: "Review the authentication flow",
          modelSelection: { instanceId: "codex" as never, model: "gpt-5.6-sol" },
        }),
    }),
  );

  return Effect.gen(function* () {
    const manager = yield* JarvisManager;
    const taskDesk = yield* JarvisTaskDesk;
    return yield* executeWithTaskDesk(manager, taskDesk, sessionId, {
      projectId,
      utterance: "Review the authentication flow",
    });
  }).pipe(
    Effect.provide(layer),
    Effect.tap(() =>
      Effect.sync(() => {
        expect(focused).toEqual([
          {
            sessionId,
            task: {
              threadId,
              projectId,
              title: "Review the authentication flow",
              objective: "Review the authentication flow",
              state: "running",
              voiceAliases: [],
            },
          },
        ]);
      }),
    ),
  );
});
