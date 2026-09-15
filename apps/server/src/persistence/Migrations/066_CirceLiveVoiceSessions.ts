import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable leases for local-key GPT-Live sessions.
 *
 * Cloud sessions are owned by the relay reservation, which is already durable,
 * so only sessions created with the node's own key need node-side recovery: a
 * node restart must still be able to close one whose renderer was killed. The
 * row is removed only after confirmed upstream closure, so a failed close is
 * never forgotten. Timestamps are epoch milliseconds.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS circe_live_voice_sessions (
      session_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_circe_live_voice_sessions_deadline
    ON circe_live_voice_sessions(deadline_at)
  `;
});
