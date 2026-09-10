import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jarvis_voice_reports (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      source_sequence INTEGER NOT NULL UNIQUE,
      report_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      request_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      speech_lease_device_id TEXT,
      speech_lease_expires_at TEXT,
      spoken_at TEXT,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jarvis_voice_report_cursors (
      session_id TEXT PRIMARY KEY,
      acknowledged_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jarvis_voice_report_projection (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      source_sequence INTEGER NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO jarvis_voice_report_projection(singleton, source_sequence)
    VALUES (1, 0)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_jarvis_voice_reports_created
    ON jarvis_voice_reports(created_at, sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_jarvis_voice_reports_request
    ON jarvis_voice_reports(thread_id, request_id, kind, active)
  `;
});
