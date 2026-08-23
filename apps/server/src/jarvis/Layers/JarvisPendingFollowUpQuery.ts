import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import {
  JarvisPendingFollowUpQuery,
  type JarvisPendingFollowUpQueryShape,
} from "../Services/JarvisPendingFollowUpQuery.ts";

const PendingThreadRow = Schema.Struct({ threadId: ThreadId });

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listReadyThreads = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingThreadRow,
    execute: () =>
      sql`
        SELECT DISTINCT queued.thread_id AS "threadId"
        FROM projection_thread_activities AS queued
        JOIN projection_thread_sessions AS session ON session.thread_id = queued.thread_id
        WHERE queued.kind = 'jarvis.followup.queued'
          AND session.status = 'ready'
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_activities AS dispatched
            WHERE dispatched.thread_id = queued.thread_id
              AND dispatched.kind = 'jarvis.followup.dispatched'
              AND json_extract(dispatched.payload_json, '$.queueId') = queued.activity_id
          )
        ORDER BY queued.thread_id ASC
      `,
  });

  return {
    listReadyThreads: () =>
      listReadyThreads().pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "JarvisPendingFollowUpQuery.listReadyThreads:query",
            "JarvisPendingFollowUpQuery.listReadyThreads:decodeRows",
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.threadId)),
      ),
  } satisfies JarvisPendingFollowUpQueryShape;
});

export const JarvisPendingFollowUpQueryLive = Layer.effect(JarvisPendingFollowUpQuery, make);
