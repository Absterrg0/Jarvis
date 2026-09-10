import { JarvisRequestMetadata, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import {
  JarvisFollowUpQueue,
  type JarvisFollowUpQueueShape,
} from "../Services/JarvisFollowUpQueue.ts";

const QueueRow = Schema.Struct({
  queueId: Schema.String,
  threadId: ThreadId,
  instruction: Schema.String,
  requestMetadata: Schema.NullOr(Schema.fromJsonString(JarvisRequestMetadata)),
  position: Schema.Number,
  enqueuedAt: Schema.String,
});

type QueueSqlRow = {
  readonly queueId: string;
  readonly threadId: string;
  readonly instruction: string;
  readonly requestMetadata: unknown;
  readonly position: number;
  readonly enqueuedAt: string;
};

const ThreadRow = Schema.Struct({ threadId: ThreadId });
const decodeQueueRow = Schema.decodeUnknownEffect(QueueRow);

function toPersistenceError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const enqueue: JarvisFollowUpQueueShape["enqueue"] = (input) =>
    sql`
      INSERT OR IGNORE INTO jarvis_follow_up_queue(
        queue_id,
        thread_id,
        instruction,
        request_metadata_json,
        status,
        enqueued_at,
        updated_at
      ) VALUES (
        ${input.queueId},
        ${input.threadId},
        ${input.instruction},
        ${input.requestMetadata === undefined ? null : JSON.stringify(input.requestMetadata)},
        'pending',
        ${input.enqueuedAt},
        ${input.enqueuedAt}
      )
    `.pipe(
      Effect.mapError(toPersistenceError("JarvisFollowUpQueue.enqueue:query", "")),
      Effect.asVoid,
    );

  const claimNext: JarvisFollowUpQueueShape["claimNext"] = (threadId) =>
    Effect.gen(function* () {
      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const rows = yield* sql<QueueSqlRow>`
        UPDATE jarvis_follow_up_queue
        SET status = 'running', claimed_at = ${now}, updated_at = ${now}
        WHERE queue_id = (
          SELECT queue_id
          FROM jarvis_follow_up_queue
          WHERE thread_id = ${threadId} AND status = 'pending'
          ORDER BY position ASC
          LIMIT 1
        ) AND status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM jarvis_follow_up_queue
          WHERE thread_id = ${threadId} AND status = 'running'
        )
        RETURNING
          queue_id AS "queueId",
          thread_id AS "threadId",
          instruction,
          request_metadata_json AS "requestMetadata",
          position,
          enqueued_at AS "enqueuedAt"
      `.pipe(Effect.mapError(toPersistenceError("JarvisFollowUpQueue.claimNext:update", "")));
      const row = rows[0];
      if (row === undefined) return Option.none();
      const decoded = yield* decodeQueueRow(row).pipe(
        Effect.mapError(
          toPersistenceError(
            "JarvisFollowUpQueue.claimNext:decode",
            "JarvisFollowUpQueue.claimNext:decode",
          ),
        ),
      );
      return Option.some({
        queueId: decoded.queueId,
        threadId: decoded.threadId,
        instruction: decoded.instruction,
        ...(decoded.requestMetadata === null ? {} : { requestMetadata: decoded.requestMetadata }),
        position: decoded.position,
        enqueuedAt: decoded.enqueuedAt,
      });
    });

  const reconcileAccepted: JarvisFollowUpQueueShape["reconcileAccepted"] = (
    threadId,
    messageIds,
    updatedAt,
  ) => {
    const queueIds = messageIds.flatMap((messageId) => {
      const prefix = "jarvis:queue:dispatch:";
      const suffix = ":message";
      return messageId.startsWith(prefix) && messageId.endsWith(suffix)
        ? [messageId.slice(prefix.length, -suffix.length)]
        : [];
    });
    if (queueIds.length === 0) return Effect.void;
    return sql`
      UPDATE jarvis_follow_up_queue
      SET status = 'dispatched', dispatched_at = COALESCE(dispatched_at, ${updatedAt}), updated_at = ${updatedAt}
      WHERE thread_id = ${threadId} AND status IN ('pending', 'running')
        AND ${sql.in("queue_id", queueIds)}
    `.pipe(
      Effect.mapError(toPersistenceError("JarvisFollowUpQueue.reconcileAccepted:query", "")),
      Effect.asVoid,
    );
  };

  const markDispatched: JarvisFollowUpQueueShape["markDispatched"] = (queueId, dispatchedAt) =>
    sql`
      UPDATE jarvis_follow_up_queue
      SET status = 'dispatched', dispatched_at = ${dispatchedAt}, updated_at = ${dispatchedAt}
      WHERE queue_id = ${queueId} AND status = 'running'
    `.pipe(
      Effect.mapError(toPersistenceError("JarvisFollowUpQueue.markDispatched:query", "")),
      Effect.asVoid,
    );

  const release: JarvisFollowUpQueueShape["release"] = (queueId, updatedAt) =>
    sql`
      UPDATE jarvis_follow_up_queue
      SET status = 'pending', claimed_at = NULL, updated_at = ${updatedAt}
      WHERE queue_id = ${queueId} AND status = 'running'
    `.pipe(
      Effect.mapError(toPersistenceError("JarvisFollowUpQueue.release:query", "")),
      Effect.asVoid,
    );

  const resetRunning: JarvisFollowUpQueueShape["resetRunning"] = (updatedAt) =>
    sql`
      UPDATE jarvis_follow_up_queue
      SET status = 'pending', claimed_at = NULL, updated_at = ${updatedAt}
      WHERE status = 'running'
    `.pipe(
      Effect.mapError(toPersistenceError("JarvisFollowUpQueue.resetRunning:query", "")),
      Effect.asVoid,
    );

  const statusOf: JarvisFollowUpQueueShape["statusOf"] = (queueId) =>
    sql<{ readonly status: string }>`
      SELECT status
      FROM jarvis_follow_up_queue
      WHERE queue_id = ${queueId}
    `.pipe(
      Effect.mapError(toPersistenceError("JarvisFollowUpQueue.statusOf:query", "")),
      Effect.map((rows) => {
        const status = rows[0]?.status;
        return status === "pending" ||
          status === "running" ||
          status === "dispatched" ||
          status === "cancelled"
          ? Option.some(status)
          : Option.none();
      }),
    );

  const cancelPending: JarvisFollowUpQueueShape["cancelPending"] = (threadId, cancelledAt) =>
    Effect.gen(function* () {
      const cancelled = yield* sql<{ readonly queueId: string }>`
        UPDATE jarvis_follow_up_queue
        SET status = 'cancelled', updated_at = ${cancelledAt}
        WHERE thread_id = ${threadId} AND status IN ('pending', 'running')
        RETURNING queue_id AS "queueId"
      `.pipe(Effect.mapError(toPersistenceError("JarvisFollowUpQueue.cancelPending:query", "")));
      return cancelled.length;
    });

  const listPendingThreadIds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadRow,
    execute: () => sql`
      SELECT queue.thread_id AS "threadId"
      FROM jarvis_follow_up_queue AS queue
      WHERE queue.status = 'pending'
      GROUP BY queue.thread_id
      ORDER BY MIN(queue.position) ASC
    `,
  });

  const pendingCount: JarvisFollowUpQueueShape["pendingCount"] = (threadId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM jarvis_follow_up_queue
      WHERE thread_id = ${threadId} AND status = 'pending'
    `.pipe(
      Effect.mapError(toPersistenceError("JarvisFollowUpQueue.pendingCount:query", "")),
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
    );

  return {
    enqueue,
    claimNext,
    markDispatched,
    reconcileAccepted,
    release,
    resetRunning,
    statusOf,
    cancelPending,
    listPendingThreadIds: () =>
      listPendingThreadIds().pipe(
        Effect.mapError(
          toPersistenceError(
            "JarvisFollowUpQueue.listPendingThreadIds:query",
            "JarvisFollowUpQueue.listPendingThreadIds:decode",
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.threadId)),
      ),
    pendingCount,
  } satisfies JarvisFollowUpQueueShape;
});

export const JarvisFollowUpQueueLive = Layer.effect(JarvisFollowUpQueue, make);
