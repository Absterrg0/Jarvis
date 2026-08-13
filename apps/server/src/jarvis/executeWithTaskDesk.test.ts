import { AuthSessionId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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
          attentionThreadId: null,
          backStack: [],
          forwardStack: [],
          recentTasks: [],
          newConversationArmed: false,
          pendingFrame: null,
          updatedAt: null,
        }),
      focus: () => Effect.die("A status request must not rewrite task focus"),
      observeLifecycle: () => Effect.die("No lifecycle is observed in this test"),
      navigate: () => Effect.die("No navigation occurs in this test"),
      consumeNewConversation: () => Effect.die("No conversation arm is consumed in this test"),
      setClarification: () => Effect.die("No clarification is set in this test"),
      resolveClarification: () => Effect.die("No clarification is resolved in this test"),
      listTrackedThreadIds: () => Effect.die("No tracked tasks are listed in this test"),
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
          attentionThreadId: null,
          backStack: [],
          forwardStack: [],
          recentTasks: [],
          newConversationArmed: false,
          pendingFrame: null,
          updatedAt: null,
        }),
      focus: (input) =>
        Effect.sync(() => {
          focused.push(input);
          return {
            focusedThreadId: input.task.threadId,
            attentionThreadId: null,
            backStack: [],
            forwardStack: [],
            recentTasks: [input.task],
            newConversationArmed: false,
            pendingFrame: null,
            updatedAt: null,
          };
        }),
      observeLifecycle: () => Effect.die("No lifecycle is observed in this test"),
      navigate: () => Effect.die("No navigation occurs in this test"),
      consumeNewConversation: () => Effect.die("No conversation arm is consumed in this test"),
      setClarification: () => Effect.die("No clarification is set in this test"),
      resolveClarification: () => Effect.die("No clarification is resolved in this test"),
      listTrackedThreadIds: () => Effect.die("No tracked tasks are listed in this test"),
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

it.effect("routes replies to blocking attention without replacing durable focus", () => {
  const focusedThreadId = ThreadId.make("thread-current-work");
  const attentionThreadId = ThreadId.make("thread-waiting-approval");
  const received: Array<JarvisManagerExecuteInput> = [];
  const layer = Layer.mergeAll(
    Layer.mock(JarvisTaskDesk)({
      get: () =>
        Effect.succeed({
          focusedThreadId,
          attentionThreadId,
          backStack: [],
          forwardStack: [],
          recentTasks: [],
          newConversationArmed: false,
          pendingFrame: null,
          updatedAt: null,
        }),
      focus: () => Effect.die("Status does not move focus"),
      observeLifecycle: () => Effect.die("No lifecycle is observed in this test"),
      navigate: () => Effect.die("No navigation occurs in this test"),
      consumeNewConversation: () => Effect.die("No conversation arm is consumed in this test"),
      setClarification: () => Effect.die("No clarification is set in this test"),
      resolveClarification: () => Effect.die("No clarification is resolved in this test"),
      listTrackedThreadIds: () => Effect.die("No tracked tasks are listed in this test"),
    }),
    Layer.mock(JarvisManager)({
      execute: (input) =>
        Effect.sync(() => {
          received.push(input);
          return {
            status: "acknowledged" as const,
            action: "status" as const,
            threadId: attentionThreadId,
            projectId: ProjectId.make("project-rivvl"),
            message: "Authentication review is waiting for approval.",
          };
        }),
    }),
  );

  return Effect.gen(function* () {
    const manager = yield* JarvisManager;
    const taskDesk = yield* JarvisTaskDesk;
    yield* executeWithTaskDesk(manager, taskDesk, AuthSessionId.make("session-companion"), {
      projectId: ProjectId.make("project-rivvl"),
      utterance: "What does that need?",
    });
    expect(received).toEqual([expect.objectContaining({ referenceThreadId: attentionThreadId })]);
  }).pipe(Effect.provide(layer));
});

it.effect("consumes new-conversation arming by stripping continuation references", () => {
  const received: Array<JarvisManagerExecuteInput> = [];
  const sessionId = AuthSessionId.make("session-new-conversation");
  const projectId = ProjectId.make("project-jarvis");
  const desk = {
    focusedThreadId: ThreadId.make("thread-old-focus"),
    attentionThreadId: null,
    backStack: [],
    forwardStack: [],
    recentTasks: [],
    newConversationArmed: true,
    pendingFrame: null,
    updatedAt: null,
  } as const;
  let cancelled = false;
  const layer = Layer.mergeAll(
    Layer.mock(JarvisTaskDesk)({
      get: () => Effect.succeed(desk),
      focus: ({ task }) =>
        Effect.succeed({ ...desk, focusedThreadId: task.threadId, newConversationArmed: false }),
      observeLifecycle: () => Effect.die("No lifecycle is observed in this test"),
      navigate: () => Effect.die("No direct navigation occurs in this test"),
      consumeNewConversation: () =>
        Effect.sync(() => {
          cancelled = true;
          return true;
        }),
      setClarification: () => Effect.die("No clarification is set in this test"),
      resolveClarification: () => Effect.die("No clarification is resolved in this test"),
      listTrackedThreadIds: () => Effect.die("No tracked tasks are listed in this test"),
    }),
    Layer.mock(JarvisManager)({
      execute: (input) =>
        Effect.sync(() => {
          received.push(input);
          return {
            status: "started" as const,
            threadId: ThreadId.make("thread-independent"),
            objective: "Start independently",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
          };
        }),
    }),
  );

  return Effect.gen(function* () {
    const manager = yield* JarvisManager;
    const taskDesk = yield* JarvisTaskDesk;
    yield* executeWithTaskDesk(manager, taskDesk, sessionId, {
      projectId,
      utterance: "Continue, but separately",
      contextThreadId: ThreadId.make("thread-context"),
      referenceThreadId: ThreadId.make("thread-client-reference"),
      continueContext: true,
    });
    expect(received).toEqual([{ projectId, utterance: "Continue, but separately" }]);
    expect(cancelled).toBe(true);
  }).pipe(Effect.provide(layer));
});

it.effect("resolves an ordinal against the durable clarification frame before normal intent", () =>
  Effect.gen(function* () {
    const sessionId = AuthSessionId.make("session-clarification");
    const projectId = ProjectId.make("project-jarvis");
    const firstThreadId = ThreadId.make("thread-first-choice");
    const secondThreadId = ThreadId.make("thread-second-choice");
    const now = yield* DateTime.now;
    let resolvedThreadId: ThreadId | null | undefined;
    const desk = {
      focusedThreadId: firstThreadId,
      attentionThreadId: null,
      backStack: [],
      forwardStack: [],
      recentTasks: [
        {
          threadId: firstThreadId,
          projectId,
          title: "First review",
          objective: "Review the first change",
          state: "ready" as const,
          voiceAliases: [],
        },
        {
          threadId: secondThreadId,
          projectId,
          title: "Second review",
          objective: "Review the second change",
          state: "ready" as const,
          voiceAliases: [],
        },
      ],
      pendingFrame: {
        originalUtterance: "Switch to the review task",
        candidates: [
          { threadId: firstThreadId, label: "1. First review" },
          { threadId: secondThreadId, label: "2. Second review" },
        ],
        createdAt: now,
        expiresAt: DateTime.add(now, { minutes: 5 }),
      },
      newConversationArmed: false,
      updatedAt: now,
    } as const;
    const layer = Layer.mergeAll(
      Layer.mock(JarvisTaskDesk)({
        get: () => Effect.succeed(desk),
        focus: () => Effect.die("Clarification does not call focus directly"),
        navigate: () => Effect.die("Clarification does not navigate directly"),
        consumeNewConversation: () => Effect.die("No conversation arm is consumed"),
        setClarification: () => Effect.die("No clarification is set"),
        resolveClarification: ({ threadId }) =>
          Effect.sync(() => {
            resolvedThreadId = threadId;
            return { ...desk, pendingFrame: null, focusedThreadId: threadId };
          }),
        observeLifecycle: () => Effect.die("No lifecycle is observed"),
        listTrackedThreadIds: () => Effect.die("No tracked tasks are listed"),
      }),
      Layer.mock(JarvisManager)({
        execute: () => Effect.die("Manager must not receive clarification replies"),
      }),
    );

    const result = yield* Effect.gen(function* () {
      const manager = yield* JarvisManager;
      const taskDesk = yield* JarvisTaskDesk;
      return yield* executeWithTaskDesk(manager, taskDesk, sessionId, {
        projectId,
        utterance: "the second one",
      });
    }).pipe(Effect.provide(layer));

    expect(resolvedThreadId).toBe(secondThreadId);
    expect(result).toMatchObject({ status: "acknowledged", action: "focused" });
  }),
);

it.effect("does not dispatch an expired clarification reply as coding work", () =>
  Effect.gen(function* () {
    const sessionId = AuthSessionId.make("session-expired-clarification");
    const projectId = ProjectId.make("project-jarvis");
    const now = yield* DateTime.now;
    let cleared = false;
    const desk = {
      focusedThreadId: null,
      attentionThreadId: null,
      backStack: [],
      forwardStack: [],
      recentTasks: [],
      pendingFrame: {
        originalUtterance: "Switch to the review task",
        candidates: [{ threadId: ThreadId.make("thread-old"), label: "1. Old review" }],
        createdAt: DateTime.subtract(now, { minutes: 10 }),
        expiresAt: DateTime.subtract(now, { minutes: 5 }),
      },
      newConversationArmed: false,
      updatedAt: now,
    } as const;
    const layer = Layer.mergeAll(
      Layer.mock(JarvisTaskDesk)({
        get: () => Effect.succeed(desk),
        focus: () => Effect.die("Expired selection does not focus"),
        navigate: () => Effect.die("Expired selection does not navigate"),
        consumeNewConversation: () => Effect.die("Expired selection does not consume arming"),
        setClarification: () => Effect.die("Expired selection does not set a frame"),
        resolveClarification: () =>
          Effect.sync(() => {
            cleared = true;
            return { ...desk, pendingFrame: null };
          }),
        observeLifecycle: () => Effect.die("No lifecycle is observed"),
        listTrackedThreadIds: () => Effect.die("No tracked tasks are listed"),
      }),
      Layer.mock(JarvisManager)({
        execute: () => Effect.die("Expired ordinal must not reach the manager"),
      }),
    );
    const result = yield* Effect.gen(function* () {
      const manager = yield* JarvisManager;
      const taskDesk = yield* JarvisTaskDesk;
      return yield* executeWithTaskDesk(manager, taskDesk, sessionId, {
        projectId,
        utterance: "the first one",
      });
    }).pipe(Effect.provide(layer));

    expect(cleared).toBe(true);
    expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
  }),
);
