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
    attentionThreadId: null,
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

    const persistEvent = Effect.fn("JarvisTaskDesk.persistEvent")(function* (
      sessionId: AuthSessionId,
      event: JarvisTaskDeskEvent,
    ) {
      const encodedEvent = yield* encodeTaskDeskEvent(event).pipe(
        Effect.mapError(toPersistenceError("JarvisTaskDesk.persistEvent:encodeEvent", sessionId)),
      );

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const next: JarvisTaskDeskState =
              event.type === "task-focused"
                ? (() => {
                    const previousFocus = current.focusedThreadId;
                    const resolvesAttention =
                      current.attentionThreadId === event.task.threadId &&
                      previousFocus !== event.task.threadId;
                    const changed =
                      !resolvesAttention &&
                      previousFocus !== null &&
                      previousFocus !== event.task.threadId;
                    return {
                      ...current,
                      focusedThreadId: resolvesAttention ? previousFocus : event.task.threadId,
                      attentionThreadId:
                        current.attentionThreadId === event.task.threadId
                          ? null
                          : current.attentionThreadId,
                      backStack: changed
                        ? retainLatestThreadIds([...current.backStack, previousFocus])
                        : current.backStack,
                      forwardStack: changed ? [] : current.forwardStack,
                      recentTasks: prioritizeTask(current.recentTasks, event.task),
                      newConversationArmed: false,
                      updatedAt: event.createdAt,
                    };
                  })()
                : (() => {
                    const existingTask = current.recentTasks.find(
                      (task) => task.threadId === event.task.threadId,
                    );
                    const reportedTask =
                      existingTask === undefined
                        ? event.task
                        : {
                            ...event.task,
                            objective: existingTask.objective,
                            voiceAliases: existingTask.voiceAliases,
                          };
                    return {
                      ...current,
                      attentionThreadId:
                        event.task.state === "waiting-for-approval" ||
                        event.task.state === "waiting-for-input"
                          ? event.task.threadId
                          : current.attentionThreadId === event.task.threadId
                            ? null
                            : current.attentionThreadId,
                      recentTasks: prioritizeTask(current.recentTasks, reportedTask),
                      updatedAt: event.createdAt,
                    };
                  })();
            const encodedDesk = yield* encodePersistedDesk(next);

            yield* sql`
              INSERT INTO jarvis_task_desk_events (session_id, event_json, created_at)
              VALUES (${sessionId}, ${encodedEvent}, ${DateTime.formatIso(event.createdAt)})
            `;
            yield* sql`
              INSERT INTO jarvis_task_desks (session_id, desk_json, updated_at)
              VALUES (${sessionId}, ${encodedDesk}, ${DateTime.formatIso(event.createdAt)})
              ON CONFLICT(session_id) DO UPDATE SET
                desk_json = excluded.desk_json,
                updated_at = excluded.updated_at
            `;
            return next;
          }),
        )
        .pipe(
          Effect.mapError(toPersistenceError("JarvisTaskDesk.persistEvent:transaction", sessionId)),
        );
    });

    const focus = Effect.fn("JarvisTaskDesk.focus")(function* (input: {
      readonly sessionId: AuthSessionId;
      readonly task: JarvisTaskDeskTask;
    }) {
      return yield* persistEvent(input.sessionId, {
        type: "task-focused",
        task: input.task,
        createdAt: yield* DateTime.now,
      });
    });

    const observeLifecycle = Effect.fn("JarvisTaskDesk.observeLifecycle")(function* (input: {
      readonly task: JarvisTaskDeskTask;
    }) {
      const rows = yield* sql<{ readonly sessionId: AuthSessionId }>`
        SELECT session_id AS sessionId
        FROM jarvis_task_desks
        WHERE json_extract(desk_json, '$.focusedThreadId') = ${input.task.threadId}
           OR json_extract(desk_json, '$.attentionThreadId') = ${input.task.threadId}
           OR EXISTS (
             SELECT 1
             FROM json_each(desk_json, '$.recentTasks')
             WHERE json_extract(value, '$.threadId') = ${input.task.threadId}
           )
      `.pipe(
        Effect.mapError((cause) =>
          isPersistenceError(cause)
            ? cause
            : new PersistenceSqlError({
                operation: "JarvisTaskDesk.observeLifecycle:query",
                correlation: { threadId: input.task.threadId },
                cause,
              }),
        ),
      );
      const createdAt = yield* DateTime.now;
      yield* Effect.forEach(
        rows,
        ({ sessionId }) =>
          persistEvent(sessionId, {
            type: "task-lifecycle-observed",
            task: input.task,
            createdAt,
          }),
        { concurrency: 1, discard: true },
      );
    });

    const listTrackedThreadIds = Effect.fn("JarvisTaskDesk.listTrackedThreadIds")(function* () {
      const rows = yield* sql<{ readonly threadId: ThreadId }>`
        SELECT DISTINCT json_extract(task.value, '$.threadId') AS threadId
        FROM jarvis_task_desks, json_each(desk_json, '$.recentTasks') AS task
      `.pipe(
        Effect.mapError((cause) =>
          isPersistenceError(cause)
            ? cause
            : new PersistenceSqlError({
                operation: "JarvisTaskDesk.listTrackedThreadIds",
                cause,
              }),
        ),
      );
      return rows.map((row) => row.threadId);
    });

    return JarvisTaskDesk.of({ get, focus, observeLifecycle, listTrackedThreadIds });
  }),
);
