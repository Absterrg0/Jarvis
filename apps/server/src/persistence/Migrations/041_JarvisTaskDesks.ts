import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jarvis_task_desk_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_jarvis_task_desk_events_session_sequence
    ON jarvis_task_desk_events(session_id, sequence)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jarvis_task_desks (
      session_id TEXT PRIMARY KEY,
      desk_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
