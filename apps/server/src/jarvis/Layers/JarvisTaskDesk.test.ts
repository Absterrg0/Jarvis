// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";
import { JarvisTaskDeskLive } from "./JarvisTaskDesk.ts";

const memoryLayer = () =>
  JarvisTaskDeskLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const task = (threadId: string) => ({
  threadId: ThreadId.make(threadId),
  projectRef: { nodeId: EnvironmentId.make("node-one"), projectId: ProjectId.make("project-one") },
  taskRef: {
    executionNodeId: EnvironmentId.make("node-one"),
    threadId: ThreadId.make(threadId),
  },
});

it.effect("persists exact focus and recent qualified identities per session", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jarvis-task-desk-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const layer = JarvisTaskDeskLive.pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"))),
      Layer.provideMerge(NodeServices.layer),
    );
    const sessionId = AuthSessionId.make("session-one");
    const first = task("thread-one");
    const second = task("thread-two");
    yield* Effect.gen(function* () {
      const desk = yield* JarvisTaskDesk;
      yield* desk.focus({ sessionId, task: first });
      const focused = yield* desk.focus({ sessionId, task: second });
      assert.deepEqual(focused.focusedTask, second);
      assert.deepEqual(focused.recentTasks, [second, first]);
    }).pipe(Effect.provide(layer));
    yield* Effect.gen(function* () {
      const desk = yield* JarvisTaskDesk;
      assert.deepEqual((yield* desk.get(sessionId)).focusedTask, second);
      assert.equal((yield* desk.get(AuthSessionId.make("session-two"))).focusedTask, null);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("stores one pending interaction and consumes it atomically", () =>
  Effect.gen(function* () {
    const desk = yield* JarvisTaskDesk;
    const sessionId = AuthSessionId.make("session-pending");
    const now = yield* DateTime.now;
    const interaction = {
      kind: "task" as const,
      frame: {
        frameId: "frame-one",
        originalUtterance: "switch to the review task",
        candidates: [{ threadId: task("thread-one").threadId, label: "1. Review" }],
        createdAt: now,
        expiresAt: DateTime.add(now, { minutes: 5 }),
      },
    };
    const saved = yield* desk.setPendingInteraction({ sessionId, interaction });
    assert.deepEqual(saved.pendingInteraction, interaction);
    assert.deepEqual(
      yield* desk.consumePendingInteraction({ sessionId, expectedFrameId: "frame-two" }),
      null,
    );
    assert.deepEqual((yield* desk.get(sessionId)).pendingInteraction, interaction);
    assert.deepEqual(
      yield* desk.consumePendingInteraction({ sessionId, expectedFrameId: "frame-one" }),
      interaction,
    );
    assert.equal((yield* desk.get(sessionId)).pendingInteraction, null);
  }).pipe(Effect.provide(memoryLayer())),
);

it.effect("rejects a stale answer without consuming its replacement", () =>
  Effect.gen(function* () {
    const desk = yield* JarvisTaskDesk;
    const sessionId = AuthSessionId.make("session-replaced");
    const now = yield* DateTime.now;
    const first = {
      kind: "task" as const,
      frame: {
        frameId: "frame-old",
        originalUtterance: "first question",
        candidates: [{ threadId: task("thread-one").threadId, label: "1. First" }],
        createdAt: now,
        expiresAt: DateTime.add(now, { minutes: 5 }),
      },
    };
    const replacement = {
      kind: "task" as const,
      frame: {
        frameId: "frame-new",
        originalUtterance: "second question",
        candidates: [{ threadId: task("thread-two").threadId, label: "1. Second" }],
        createdAt: now,
        expiresAt: DateTime.add(now, { minutes: 5 }),
      },
    };
    yield* desk.setPendingInteraction({ sessionId, interaction: first });
    yield* desk.setPendingInteraction({ sessionId, interaction: replacement });
    assert.deepEqual(
      yield* desk.consumePendingInteraction({ sessionId, expectedFrameId: "frame-old" }),
      null,
    );
    assert.deepEqual((yield* desk.get(sessionId)).pendingInteraction, replacement);
  }).pipe(Effect.provide(memoryLayer())),
);
