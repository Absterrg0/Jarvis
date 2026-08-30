import {
  JarvisPendingInteraction,
  JarvisTaskDeskState,
  type AuthSessionId,
  type JarvisTaskDeskTask,
  type JarvisTaskDeskNavigation,
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
import { JarvisTaskDesk } from "../Services/JarvisTaskDesk.ts";

const MAX_RECENT_TASKS = 20;
const PersistedDeskRow = Schema.Struct({ deskJson: Schema.fromJsonString(JarvisTaskDeskState) });
const decodeDeskRow = Schema.decodeUnknownEffect(PersistedDeskRow);
const encodeDesk = Schema.encodeEffect(Schema.fromJsonString(JarvisTaskDeskState));

function emptyDesk(): JarvisTaskDeskState {
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

export const JarvisTaskDeskLive = Layer.effect(
  JarvisTaskDesk,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const get = Effect.fn("JarvisTaskDesk.get")(function* (sessionId: AuthSessionId) {
      const rows = yield* sql<{ readonly deskJson: unknown }>`
        SELECT desk_json AS deskJson FROM jarvis_task_desks WHERE session_id = ${sessionId}
      `.pipe(Effect.mapError(toPersistenceError("JarvisTaskDesk.get:query", sessionId)));
      const row = rows[0];
      if (row === undefined) return emptyDesk();
      return yield* decodeDeskRow(row).pipe(
        Effect.map((decoded) => decoded.deskJson),
        Effect.mapError(toPersistenceError("JarvisTaskDesk.get:decode", sessionId)),
      );
    });

    const update = Effect.fn("JarvisTaskDesk.update")(function* (
      sessionId: AuthSessionId,
      mutate: (current: JarvisTaskDeskState) => JarvisTaskDeskState,
    ) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const next = mutate(current);
            const encoded = yield* encodeDesk(next).pipe(
              Effect.mapError(toPersistenceError("JarvisTaskDesk.update:encode", sessionId)),
            );
            const now = next.updatedAt === null ? yield* DateTime.now : next.updatedAt;
            yield* sql`
            INSERT INTO jarvis_task_desks(session_id, desk_json, updated_at)
            VALUES (${sessionId}, ${encoded}, ${DateTime.formatIso(now)})
            ON CONFLICT(session_id) DO UPDATE SET
              desk_json = excluded.desk_json,
              updated_at = excluded.updated_at
          `;
            return next;
          }),
        )
        .pipe(Effect.mapError(toPersistenceError("JarvisTaskDesk.update:transaction", sessionId)));
    });

    const focus = Effect.fn("JarvisTaskDesk.focus")(function* (input: {
      readonly sessionId: AuthSessionId;
      readonly task: JarvisTaskDeskTask;
    }) {
      const now = yield* DateTime.now;
      return yield* update(input.sessionId, (current) => ({
        focusedTask: input.task,
        recentTasks: [
          input.task,
          ...current.recentTasks.filter((task) => task.threadId !== input.task.threadId),
        ].slice(0, MAX_RECENT_TASKS),
        pendingInteraction: null,
        updatedAt: now,
      }));
    });

    const navigate = Effect.fn("JarvisTaskDesk.navigate")(function* (input: {
      readonly sessionId: AuthSessionId;
      readonly navigation: JarvisTaskDeskNavigation;
    }) {
      const current = yield* get(input.sessionId);
      const task = current.recentTasks.find(
        (candidate) => candidate.threadId === input.navigation.threadId,
      );
      if (task === undefined) return current;
      if (
        input.navigation.taskRef !== undefined &&
        (input.navigation.taskRef.remoteTaskId !== task.taskRef?.remoteTaskId ||
          input.navigation.taskRef.executionNodeId !== task.taskRef?.executionNodeId)
      ) {
        return current;
      }
      return yield* focus({ sessionId: input.sessionId, task });
    });

    const setPendingInteraction = Effect.fn("JarvisTaskDesk.setPendingInteraction")(
      function* (input: {
        readonly sessionId: AuthSessionId;
        readonly interaction: JarvisPendingInteraction;
      }) {
        const now = yield* DateTime.now;
        return yield* update(input.sessionId, (current) => ({
          ...current,
          pendingInteraction: input.interaction,
          updatedAt: now,
        }));
      },
    );

    const clearPendingInteraction = Effect.fn("JarvisTaskDesk.clearPendingInteraction")(function* (
      sessionId: AuthSessionId,
    ) {
      const now = yield* DateTime.now;
      return yield* update(sessionId, (current) => ({
        ...current,
        pendingInteraction: null,
        updatedAt: now,
      }));
    });

    const consumePendingInteraction = Effect.fn("JarvisTaskDesk.consumePendingInteraction")(
      function* (sessionId: AuthSessionId) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const current = yield* get(sessionId);
              const pending = current.pendingInteraction;
              if (pending === null) return null;
              const now = yield* DateTime.now;
              const next = { ...current, pendingInteraction: null, updatedAt: now };
              const encoded = yield* encodeDesk(next).pipe(
                Effect.mapError(toPersistenceError("JarvisTaskDesk.consume:encode", sessionId)),
              );
              yield* sql`
              INSERT INTO jarvis_task_desks(session_id, desk_json, updated_at)
              VALUES (${sessionId}, ${encoded}, ${DateTime.formatIso(now)})
              ON CONFLICT(session_id) DO UPDATE SET
                desk_json = excluded.desk_json,
                updated_at = excluded.updated_at
            `;
              return pending;
            }),
          )
          .pipe(
            Effect.mapError(toPersistenceError("JarvisTaskDesk.consume:transaction", sessionId)),
          );
      },
    );

    return JarvisTaskDesk.of({
      get,
      focus,
      navigate,
      setPendingInteraction,
      consumePendingInteraction,
      clearPendingInteraction,
    });
  }),
);
