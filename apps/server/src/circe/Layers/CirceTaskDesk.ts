import {
  CircePendingInteraction,
  CirceTaskDeskState,
  type AuthSessionId,
  type CirceFocusTaskInput,
  type CirceTaskDeskTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  isPersistenceError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "../../persistence/Errors.ts";
import { CirceTaskDesk } from "../Services/CirceTaskDesk.ts";

const MAX_RECENT_TASKS = 20;
const PersistedDeskRow = Schema.Struct({ deskJson: Schema.fromJsonString(CirceTaskDeskState) });
const decodeDeskRow = Schema.decodeUnknownEffect(PersistedDeskRow);
const encodeDesk = Schema.encodeEffect(Schema.fromJsonString(CirceTaskDeskState));

function emptyDesk(): CirceTaskDeskState {
  return { focusedTask: null, recentTasks: [], pendingInteraction: null, updatedAt: null };
}

function toPersistenceError(operation: string, sessionId: AuthSessionId) {
  return (cause: unknown) =>
    isPersistenceError(cause)
      ? cause
      : Schema.isSchemaError(cause)
        ? PersistenceDecodeError.fromSchemaError(operation, cause, { sessionId })
        : new PersistenceSqlError({ operation, correlation: { sessionId }, cause });
}

export const CirceTaskDeskLive = Layer.effect(
  CirceTaskDesk,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const get = Effect.fn("CirceTaskDesk.get")(function* (sessionId: AuthSessionId) {
      const rows = yield* sql<{ readonly deskJson: unknown }>`
        SELECT desk_json AS deskJson FROM circe_task_desks WHERE session_id = ${sessionId}
      `.pipe(Effect.mapError(toPersistenceError("CirceTaskDesk.get:query", sessionId)));
      const row = rows[0];
      if (row === undefined) return emptyDesk();
      return yield* decodeDeskRow(row).pipe(
        Effect.map((decoded) => decoded.deskJson),
        Effect.mapError(toPersistenceError("CirceTaskDesk.get:decode", sessionId)),
      );
    });

    const update = Effect.fn("CirceTaskDesk.update")(function* (
      sessionId: AuthSessionId,
      mutate: (current: CirceTaskDeskState) => CirceTaskDeskState,
    ) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const next = mutate(current);
            const encoded = yield* encodeDesk(next).pipe(
              Effect.mapError(toPersistenceError("CirceTaskDesk.update:encode", sessionId)),
            );
            const now = next.updatedAt === null ? yield* DateTime.now : next.updatedAt;
            yield* sql`
            INSERT INTO circe_task_desks(session_id, desk_json, updated_at)
            VALUES (${sessionId}, ${encoded}, ${DateTime.formatIso(now)})
            ON CONFLICT(session_id) DO UPDATE SET
              desk_json = excluded.desk_json,
              updated_at = excluded.updated_at
          `;
            return next;
          }),
        )
        .pipe(Effect.mapError(toPersistenceError("CirceTaskDesk.update:transaction", sessionId)));
    });

    const focus = Effect.fn("CirceTaskDesk.focus")(function* (input: {
      readonly sessionId: AuthSessionId;
      readonly task: CirceTaskDeskTask | CirceFocusTaskInput;
      readonly preservePendingInteraction?: boolean;
    }) {
      const task =
        "projectRef" in input.task
          ? input.task
          : (yield* get(input.sessionId)).recentTasks.find(
              (candidate) =>
                candidate.threadId === input.task.threadId &&
                candidate.taskRef.threadId === input.task.taskRef.threadId &&
                candidate.taskRef.executionNodeId === input.task.taskRef.executionNodeId,
            );
      if (task === undefined) return yield* get(input.sessionId);
      const now = yield* DateTime.now;
      return yield* update(input.sessionId, (current) => ({
        focusedTask: task,
        recentTasks: [
          task,
          ...current.recentTasks.filter((candidate) => candidate.threadId !== task.threadId),
        ].slice(0, MAX_RECENT_TASKS),
        pendingInteraction: input.preservePendingInteraction ? current.pendingInteraction : null,
        updatedAt: now,
      }));
    });

    const setPendingInteraction = Effect.fn("CirceTaskDesk.setPendingInteraction")(
      function* (input: {
        readonly sessionId: AuthSessionId;
        readonly interaction: CircePendingInteraction;
      }) {
        const now = yield* DateTime.now;
        return yield* update(input.sessionId, (current) => ({
          ...current,
          pendingInteraction: input.interaction,
          updatedAt: now,
        }));
      },
    );

    const clearPendingInteraction = Effect.fn("CirceTaskDesk.clearPendingInteraction")(
      function* (input: { readonly sessionId: AuthSessionId; readonly expectedFrameId?: string }) {
        const sessionId = input.sessionId;
        const now = yield* DateTime.now;
        return yield* update(sessionId, (current) => {
          if (
            input.expectedFrameId !== undefined &&
            current.pendingInteraction?.frame.frameId !== input.expectedFrameId
          ) {
            return current;
          }
          return {
            ...current,
            pendingInteraction: null,
            updatedAt: now,
          };
        });
      },
    );

    const consumePendingInteraction = Effect.fn("CirceTaskDesk.consumePendingInteraction")(
      function* (input: {
        readonly sessionId: AuthSessionId;
        readonly expectedFrameId?: string;
        readonly focusTask?: CirceTaskDeskTask;
      }) {
        const sessionId = input.sessionId;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const current = yield* get(sessionId);
              const pending = current.pendingInteraction;
              if (pending === null) return null;
              if (pending.frame.frameId !== input.expectedFrameId) {
                return null;
              }
              const now = yield* DateTime.now;
              const focusedTask = input.focusTask;
              if (
                focusedTask !== undefined &&
                (pending.kind !== "task" ||
                  !pending.frame.candidates.some(
                    (candidate) =>
                      candidate.threadId === focusedTask.threadId &&
                      candidate.taskRef?.executionNodeId === focusedTask.taskRef.executionNodeId &&
                      candidate.taskRef.threadId === focusedTask.taskRef.threadId,
                  ))
              )
                return null;
              const next = {
                ...current,
                pendingInteraction: null,
                updatedAt: now,
                ...(focusedTask === undefined
                  ? {}
                  : {
                      focusedTask,
                      recentTasks: [
                        focusedTask,
                        ...current.recentTasks.filter(
                          (task) => task.threadId !== focusedTask.threadId,
                        ),
                      ].slice(0, MAX_RECENT_TASKS),
                    }),
              };
              const encoded = yield* encodeDesk(next).pipe(
                Effect.mapError(toPersistenceError("CirceTaskDesk.consume:encode", sessionId)),
              );
              yield* sql`
              INSERT INTO circe_task_desks(session_id, desk_json, updated_at)
              VALUES (${sessionId}, ${encoded}, ${DateTime.formatIso(now)})
              ON CONFLICT(session_id) DO UPDATE SET
                desk_json = excluded.desk_json,
                updated_at = excluded.updated_at
            `;
              return pending;
            }),
          )
          .pipe(
            Effect.mapError(toPersistenceError("CirceTaskDesk.consume:transaction", sessionId)),
          );
      },
    );

    return CirceTaskDesk.of({
      get,
      focus,
      setPendingInteraction,
      consumePendingInteraction,
      clearPendingInteraction,
    });
  }),
);
