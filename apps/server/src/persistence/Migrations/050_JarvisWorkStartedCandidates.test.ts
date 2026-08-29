import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_JarvisWorkStartedCandidates", (it) => {
  it.effect("backfills report changes with report sequences without moving the cursor", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO jarvis_voice_reports(
          sequence, source_sequence, report_id, thread_id, kind, active, report_json, created_at
        ) VALUES
          (11, 101, 'active-report', 'thread-1', 'completed', 1, '{"reportId":"active-report"}', '2026-01-01T00:00:00.000Z'),
          (23, 102, 'inactive-report', 'thread-1', 'waiting-for-input', 0, '{"reportId":"inactive-report"}', '2026-01-02T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO jarvis_voice_report_cursors(session_id, acknowledged_sequence, updated_at)
        VALUES ('cursor-1', 7, '2026-01-03T00:00:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 50 });
      const reportColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(jarvis_voice_reports)
      `;
      assert.isTrue(reportColumns.some((column) => column.name === "turn_id"));
      const candidateColumns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(jarvis_voice_work_started_candidates)
      `;
      assert.isTrue(
        candidateColumns.some((column) => column.name === "updated_at" && column.notnull === 1),
      );

      const changes = yield* sql<{
        readonly sequence: number;
        readonly reportId: string;
        readonly changeKind: string;
        readonly reportJson: string | null;
      }>`
        SELECT sequence, report_id AS reportId, change_kind AS changeKind, report_json AS reportJson
        FROM jarvis_voice_report_changes ORDER BY sequence
      `;
      assert.deepEqual(changes, [
        {
          sequence: 11,
          reportId: "active-report",
          changeKind: "upsert",
          reportJson: '{"reportId":"active-report"}',
        },
        { sequence: 23, reportId: "inactive-report", changeKind: "remove", reportJson: null },
      ]);
      const cursor = yield* sql<{
        readonly acknowledgedSequence: number;
        readonly updatedAt: string;
      }>`
        SELECT acknowledged_sequence AS acknowledgedSequence, updated_at AS updatedAt
        FROM jarvis_voice_report_cursors WHERE session_id = 'cursor-1'
      `;
      assert.deepEqual(cursor[0], {
        acknowledgedSequence: 7,
        updatedAt: "2026-01-03T00:00:00.000Z",
      });
      const inserted = yield* sql<{ readonly sequence: number }>`
        INSERT INTO jarvis_voice_report_changes(report_id, change_kind, report_json, created_at)
        VALUES ('next-report', 'remove', NULL, '2026-01-04T00:00:00.000Z') RETURNING sequence
      `;
      assert.isAbove(inserted[0]?.sequence ?? 0, 23);
    }),
  );
});
