import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jarvis_follow_up_queue (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id TEXT NOT NULL UNIQUE,
      dispatch_identity TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      execution_node_id TEXT,
      provider_id TEXT,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'dispatched', 'cancelled')),
      enqueued_at TEXT NOT NULL,
      claimed_at TEXT,
      dispatched_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_jarvis_follow_up_queue_pending
    ON jarvis_follow_up_queue(status, position)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_jarvis_follow_up_queue_thread
    ON jarvis_follow_up_queue(thread_id, status, position)
  `;

  // Convert follow-up activities written by older versions into durable queue
  // rows. Dispatched activities are omitted because they already ran.
  yield* sql`
    INSERT OR IGNORE INTO jarvis_follow_up_queue(
      queue_id,
      dispatch_identity,
      thread_id,
      project_id,
      instruction,
      status,
      enqueued_at,
      updated_at
    )
    SELECT
      queued.activity_id,
      'jarvis:queue:dispatch:' || queued.activity_id,
      queued.thread_id,
      threads.project_id,
      queued.summary,
      'pending',
      queued.created_at,
      queued.created_at
    FROM projection_thread_activities AS queued
    JOIN projection_threads AS threads ON threads.thread_id = queued.thread_id
    WHERE queued.kind = 'jarvis.followup.queued'
      AND NOT EXISTS (
        SELECT 1
        FROM projection_thread_activities AS dispatched
        WHERE dispatched.thread_id = queued.thread_id
          AND dispatched.kind = 'jarvis.followup.dispatched'
          AND json_extract(dispatched.payload_json, '$.queueId') = queued.activity_id
      )
  `;
});
