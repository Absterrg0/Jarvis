// @effect-diagnostics preferSchemaOverJson:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_JarvisTaskDeskCurrentState", (it) => {
  it.effect("backfills a compact session snapshot and removes desk event history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO jarvis_task_desks(session_id, desk_json, updated_at)
        VALUES (
          'session-one',
          ${JSON.stringify({
            focusedThreadId: "thread-one",
            attentionThreadId: "thread-blocked",
            backStack: ["thread-old"],
            forwardStack: [],
            recentTasks: [
              {
                threadId: "thread-one",
                projectId: "project-one",
                title: "One",
                objective: "Do one",
                state: "running",
                voiceAliases: [],
                taskRef: {
                  executionNodeId: "node-one",
                  remoteTaskId: "remote-one",
                  projectId: "project-one",
                },
              },
              {
                threadId: "legacy-unqualified",
                projectId: "project-one",
                title: "Legacy",
                objective: "Cannot safely route",
              },
            ],
            pendingFrame: null,
            pendingProjectFrame: null,
            newConversationArmed: false,
            updatedAt: "2026-08-30T00:00:00.000Z",
          })},
          '2026-08-30T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });

      const rows = yield* sql<{ readonly deskJson: string }>`
        SELECT desk_json AS deskJson FROM jarvis_task_desks WHERE session_id = 'session-one'
      `;
      assert.deepEqual(JSON.parse(rows[0]!.deskJson), {
        focusedTask: {
          threadId: "thread-one",
          taskRef: {
            executionNodeId: "node-one",
            remoteTaskId: "remote-one",
            projectId: "project-one",
          },
          projectRef: { nodeId: "node-one", projectId: "project-one" },
        },
        recentTasks: [
          {
            threadId: "thread-one",
            taskRef: {
              executionNodeId: "node-one",
              remoteTaskId: "remote-one",
              projectId: "project-one",
            },
            projectRef: { nodeId: "node-one", projectId: "project-one" },
          },
        ],
        pendingInteraction: null,
        updatedAt: "2026-08-30T00:00:00.000Z",
      });

      const history = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jarvis_task_desk_events'
      `;
      assert.deepEqual(history, []);
    }),
  );
});
