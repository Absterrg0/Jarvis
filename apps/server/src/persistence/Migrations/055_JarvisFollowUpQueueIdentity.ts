import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`ALTER TABLE jarvis_follow_up_queue RENAME TO jarvis_follow_up_queue_snapshot`;
      yield* sql`
        CREATE TABLE jarvis_follow_up_queue (
          position INTEGER PRIMARY KEY AUTOINCREMENT,
          queue_id TEXT NOT NULL UNIQUE,
          thread_id TEXT NOT NULL,
          instruction TEXT NOT NULL,
          request_metadata_json TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'running', 'dispatched', 'cancelled')),
          enqueued_at TEXT NOT NULL,
          claimed_at TEXT,
          dispatched_at TEXT,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO jarvis_follow_up_queue(
          position,
          queue_id,
          thread_id,
          instruction,
          request_metadata_json,
          status,
          enqueued_at,
          claimed_at,
          dispatched_at,
          updated_at
        )
        SELECT
          position,
          queue_id,
          thread_id,
          instruction,
          NULL,
          status,
          enqueued_at,
          claimed_at,
          dispatched_at,
          updated_at
        FROM jarvis_follow_up_queue_snapshot
      `;
      yield* sql`DROP TABLE jarvis_follow_up_queue_snapshot`;
      yield* sql`
        CREATE INDEX idx_jarvis_follow_up_queue_pending
        ON jarvis_follow_up_queue(status, position)
      `;
      yield* sql`
        CREATE INDEX idx_jarvis_follow_up_queue_thread
        ON jarvis_follow_up_queue(thread_id, status, position)
      `;
    }),
  );
});
