import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE jarvis_voice_reports ADD COLUMN turn_id TEXT
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_jarvis_voice_reports_turn
    ON jarvis_voice_reports(thread_id, turn_id, kind, active)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jarvis_voice_work_started_candidates (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      assistant_message_id TEXT,
      source_sequence INTEGER,
      report_json TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'staged' CHECK (phase IN ('staged', 'promoted', 'dismissed')),
      report_id TEXT,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jarvis_voice_report_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL,
      change_kind TEXT NOT NULL CHECK (change_kind IN ('upsert', 'remove')),
      report_json TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO jarvis_voice_report_changes(sequence, report_id, change_kind, report_json, created_at)
    SELECT sequence, report_id, CASE WHEN active = 1 THEN 'upsert' ELSE 'remove' END,
      CASE WHEN active = 1 THEN report_json ELSE NULL END, created_at FROM jarvis_voice_reports
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_jarvis_voice_work_started_candidates_source
    ON jarvis_voice_work_started_candidates(source_sequence)
  `;
});
