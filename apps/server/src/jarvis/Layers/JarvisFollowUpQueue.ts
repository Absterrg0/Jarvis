import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
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
  dispatchIdentity: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
  executionNodeId: Schema.NullOr(EnvironmentId),
  providerId: Schema.NullOr(Schema.String),
  instruction: Schema.String,
  position: Schema.Number,
});

type QueueSqlRow = {
  readonly queueId: string;
  readonly dispatchIdentity: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly executionNodeId: string | null;
  readonly providerId: string | null;
  readonly instruction: string;
  readonly position: number;
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
        dispatch_identity,
        thread_id,
        project_id,
        execution_node_id,
        provider_id,
        instruction,
        status,
        enqueued_at,
        updated_at
      ) VALUES (
        ${input.queueId},
        ${input.dispatchIdentity},
        ${input.threadId},
        ${input.projectId},
        ${input.executionNodeId ?? null},
        ${input.modelSelection?.instanceId ?? null},
        ${input.instruction},
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
        RETURNING
          queue_id AS "queueId",
          dispatch_identity AS "dispatchIdentity",
          thread_id AS "threadId",
          project_id AS "projectId",
          execution_node_id AS "executionNodeId",
          provider_id AS "providerId",
          instruction,
          position
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
        dispatchIdentity: decoded.dispatchIdentity,
        threadId: decoded.threadId,
        projectId: decoded.projectId,
        ...(decoded.executionNodeId === null ? {} : { executionNodeId: decoded.executionNodeId }),
        ...(decoded.providerId === null ? {} : { providerId: decoded.providerId }),
        instruction: decoded.instruction,
        position: decoded.position,
      });
    });

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

  const cancelPending: JarvisFollowUpQueueShape["cancelPending"] = (threadId, cancelledAt) =>
    sql<{ readonly queueId: string }>`
      UPDATE jarvis_follow_up_queue
      SET status = 'cancelled', updated_at = ${cancelledAt}
      WHERE thread_id = ${threadId} AND status = 'pending'
      RETURNING queue_id AS "queueId"
    `.pipe(
      Effect.mapError(toPersistenceError("JarvisFollowUpQueue.cancelPending:query", "")),
      Effect.map((rows) => rows.length),
    );

  const listReadyThreadIds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadRow,
    execute: () => sql`
      SELECT DISTINCT queue.thread_id AS "threadId"
      FROM jarvis_follow_up_queue AS queue
      JOIN projection_thread_sessions AS session ON session.thread_id = queue.thread_id
      WHERE queue.status = 'pending' AND session.status = 'ready'
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
    release,
    resetRunning,
    cancelPending,
    listReadyThreadIds: () =>
      listReadyThreadIds().pipe(
        Effect.mapError(
          toPersistenceError(
            "JarvisFollowUpQueue.listReadyThreadIds:query",
            "JarvisFollowUpQueue.listReadyThreadIds:decode",
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.threadId)),
      ),
    pendingCount,
  } satisfies JarvisFollowUpQueueShape;
});

export const JarvisFollowUpQueueLive = Layer.effect(JarvisFollowUpQueue, make);
