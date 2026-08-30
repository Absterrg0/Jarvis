import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_JarvisFollowUpQueue", (it) => {
  it.effect("creates the queue and migrates un-dispatched follow-up activities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, model_selection_json, created_at, updated_at) VALUES ('thread-old', 'project-old', 'Old', '{"instanceId":"codex","model":"sol"}', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_activities(activity_id, thread_id, tone, kind, summary, payload_json, created_at) VALUES ('old-queued', 'thread-old', 'info', 'jarvis.followup.queued', 'old instruction', '{}', '2026-08-30T00:01:00.000Z')`;
      yield* runMigrations({ toMigrationInclusive: 51 });
      const rows = yield* sql<{
        readonly queueId: string;
        readonly instruction: string;
        readonly status: string;
      }>`
        SELECT queue_id AS queueId, instruction, status
        FROM jarvis_follow_up_queue
      `;
      assert.deepEqual(rows, [
        { queueId: "old-queued", instruction: "old instruction", status: "pending" },
      ]);
    }),
  );
});
