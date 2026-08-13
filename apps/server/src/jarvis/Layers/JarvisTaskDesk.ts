import {
  JarvisTaskDeskEvent,
  JarvisTaskDeskState,
  type AuthSessionId,
  type JarvisTaskDeskTask,
  type ThreadId,
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

const MAX_HISTORY = 20;

const PersistedDeskRow = Schema.Struct({
  deskJson: Schema.fromJsonString(JarvisTaskDeskState),
});
const decodePersistedDeskRow = Schema.decodeUnknownEffect(PersistedDeskRow);
const encodePersistedDesk = Schema.encodeEffect(Schema.fromJsonString(JarvisTaskDeskState));
const encodeTaskDeskEvent = Schema.encodeEffect(Schema.fromJsonString(JarvisTaskDeskEvent));

function emptyDesk(): JarvisTaskDeskState {
  return {
    focusedThreadId: null,
    backStack: [],
    forwardStack: [],
    recentTasks: [],
    newConversationArmed: false,
    updatedAt: null,
  };
}

function retainLatestThreadIds(threadIds: ReadonlyArray<ThreadId>): ReadonlyArray<ThreadId> {
  return threadIds.slice(-MAX_HISTORY);
}

function prioritizeTask(
  tasks: ReadonlyArray<JarvisTaskDeskTask>,
  focused: JarvisTaskDeskTask,
): ReadonlyArray<JarvisTaskDeskTask> {
  return [focused, ...tasks.filter((task) => task.threadId !== focused.threadId)].slice(
    0,
    MAX_HISTORY,
  );
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
        SELECT desk_json AS deskJson
        FROM jarvis_task_desks
        WHERE session_id = ${sessionId}
      `.pipe(Effect.mapError(toPersistenceError("JarvisTaskDesk.get:query", sessionId)));
      const row = rows[0];
      if (row === undefined) {
        return emptyDesk();
      }
      return yield* decodePersistedDeskRow(row).pipe(
        Effect.map((decoded) => decoded.deskJson),
        Effect.mapError(toPersistenceError("JarvisTaskDesk.get:decode", sessionId)),
      );
    });

    const focus = Effect.fn("JarvisTaskDesk.focus")(function* (input: {
      readonly sessionId: AuthSessionId;
      readonly task: JarvisTaskDeskTask;
    }) {
      const updatedAt = yield* DateTime.now;
      const event: JarvisTaskDeskEvent = {
        type: "task-focused",
        task: input.task,
        createdAt: updatedAt,
      };
      const encodedEvent = yield* encodeTaskDeskEvent(event).pipe(
        Effect.mapError(toPersistenceError("JarvisTaskDesk.focus:encodeEvent", input.sessionId)),
      );

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* get(input.sessionId);
            const previousFocus = current.focusedThreadId;
            const changed = previousFocus !== null && previousFocus !== input.task.threadId;
            const next: JarvisTaskDeskState = {
              ...current,
              focusedThreadId: input.task.threadId,
              backStack: changed
                ? retainLatestThreadIds([...current.backStack, previousFocus])
                : current.backStack,
              forwardStack: changed ? [] : current.forwardStack,
              recentTasks: prioritizeTask(current.recentTasks, input.task),
              newConversationArmed: false,
              updatedAt,
            };
            const encodedDesk = yield* encodePersistedDesk(next);

            yield* sql`
              INSERT INTO jarvis_task_desk_events (session_id, event_json, created_at)
              VALUES (${input.sessionId}, ${encodedEvent}, ${DateTime.formatIso(updatedAt)})
            `;
            yield* sql`
              INSERT INTO jarvis_task_desks (session_id, desk_json, updated_at)
              VALUES (${input.sessionId}, ${encodedDesk}, ${DateTime.formatIso(updatedAt)})
              ON CONFLICT(session_id) DO UPDATE SET
                desk_json = excluded.desk_json,
                updated_at = excluded.updated_at
            `;
            return next;
          }),
        )
        .pipe(
          Effect.mapError(toPersistenceError("JarvisTaskDesk.focus:transaction", input.sessionId)),
        );
    });

    return JarvisTaskDesk.of({ get, focus });
  }),
);
