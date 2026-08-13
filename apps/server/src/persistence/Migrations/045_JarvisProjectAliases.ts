import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jarvis_project_alias_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_jarvis_project_alias_events_project_sequence
    ON jarvis_project_alias_events(project_id, sequence)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jarvis_project_aliases (
      project_id TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      alias TEXT NOT NULL,
      kind TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, normalized_alias)
    )
  `;
});
