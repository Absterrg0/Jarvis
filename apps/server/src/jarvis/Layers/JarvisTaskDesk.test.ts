// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";
import { JarvisTaskDeskLive } from "./JarvisTaskDesk.ts";

const makeTaskDeskMemoryLayer = () =>
  JarvisTaskDeskLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("retains focused task across restart without sharing it with another session", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jarvis-task-desk-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const dbPath = NodePath.join(tempDir, "state.sqlite");
    const layer = JarvisTaskDeskLive.pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
      Layer.provideMerge(NodeServices.layer),
    );
    const sessionId = AuthSessionId.make("session-companion");
    const task = {
      threadId: ThreadId.make("thread-auth-review"),
      projectId: ProjectId.make("project-rivvl"),
      title: "Authentication review",
      objective: "Review the authentication flow",
      state: "running" as const,
      voiceAliases: [],
    };

    yield* Effect.gen(function* () {
      const taskDesk = yield* JarvisTaskDesk;
      const desk = yield* taskDesk.focus({ sessionId, task });

      assert.equal(desk.focusedThreadId, task.threadId);
      assert.deepEqual(desk.recentTasks, [task]);
    }).pipe(Effect.provide(layer));

    yield* Effect.gen(function* () {
      const taskDesk = yield* JarvisTaskDesk;
      const sql = yield* SqlClient.SqlClient;
      const desk = yield* taskDesk.get(sessionId);
      const otherDesk = yield* taskDesk.get(AuthSessionId.make("session-other-device"));
      const events = yield* sql<{ readonly eventJson: string }>`
        SELECT event_json AS eventJson
        FROM jarvis_task_desk_events
        WHERE session_id = ${sessionId}
        ORDER BY sequence ASC
      `;

      assert.equal(desk.focusedThreadId, task.threadId);
      assert.deepEqual(desk.recentTasks, [task]);
      assert.equal(otherDesk.focusedThreadId, null);
      assert.deepEqual(otherDesk.recentTasks, []);
      assert.equal(events.length, 1);
      assert.include(events[0]!.eventJson, '"type":"task-focused"');
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("raises blocking attention without replacing conversation focus", () =>
  Effect.gen(function* () {
    const taskDesk = yield* JarvisTaskDesk;
    const sessionId = AuthSessionId.make("session-companion-attention");
    const focusedTask = {
      threadId: ThreadId.make("thread-implementation"),
      projectId: ProjectId.make("project-jarvis"),
      title: "Voice implementation",
      objective: "Improve voice routing",
      state: "running" as const,
      voiceAliases: [],
    };
    const blockedTask = {
      threadId: ThreadId.make("thread-auth-review"),
      projectId: ProjectId.make("project-rivvl"),
      title: "Authentication review",
      objective: "Review authentication",
      state: "waiting-for-approval" as const,
      voiceAliases: [],
    };

    yield* taskDesk.focus({ sessionId, task: blockedTask });
    yield* taskDesk.focus({ sessionId, task: focusedTask });
    yield* taskDesk.observeLifecycle({ task: blockedTask });
    const desk = yield* taskDesk.get(sessionId);

    assert.equal(desk.focusedThreadId, focusedTask.threadId);
    assert.equal(desk.attentionThreadId, blockedTask.threadId);
    assert.deepEqual(desk.recentTasks, [blockedTask, focusedTask]);

    yield* taskDesk.observeLifecycle({ task: { ...blockedTask, state: "ready" } });
    const completed = yield* taskDesk.get(sessionId);
    assert.equal(completed.focusedThreadId, focusedTask.threadId);
    assert.equal(completed.attentionThreadId, null);
    assert.equal(completed.recentTasks[0]?.state, "ready");

    yield* taskDesk.observeLifecycle({ task: blockedTask });
    yield* taskDesk.focus({ sessionId, task: { ...blockedTask, state: "running" } });
    const resumed = yield* taskDesk.get(sessionId);
    assert.equal(resumed.focusedThreadId, focusedTask.threadId);
    assert.equal(resumed.attentionThreadId, null);
    assert.equal(resumed.recentTasks[0]?.state, "running");
  }).pipe(Effect.provide(makeTaskDeskMemoryLayer())),
);
