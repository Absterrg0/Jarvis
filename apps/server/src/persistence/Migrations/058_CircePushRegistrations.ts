import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS circe_push_registrations (
      token TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_circe_push_registrations_node
    ON circe_push_registrations(node_id)
  `;
});
