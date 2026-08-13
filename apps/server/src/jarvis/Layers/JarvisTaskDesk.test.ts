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

import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";
import { JarvisTaskDeskLive } from "./JarvisTaskDesk.ts";

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
