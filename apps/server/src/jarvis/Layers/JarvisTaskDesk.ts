import {
  JarvisTaskDeskEvent,
  JarvisTaskDeskState,
  type AuthSessionId,
  type JarvisTaskDeskTask,
  type JarvisTaskDeskNavigation,
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
    pendingFrame: null,
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
                : event.type === "task-lifecycle-observed"
                  ? (() => {
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
                    })()
                  : event.type === "navigation-applied"
                    ? (() => {
                        const navigation = event.navigation;
                        if (
                          navigation.action === "new-conversation" ||
                          navigation.action === "cancel-new-conversation"
                        ) {
                          return {
                            ...current,
                            newConversationArmed: navigation.action === "new-conversation",
                            updatedAt: event.createdAt,
                          };
                        }
                        if (navigation.action === "focus") {
                          const task = current.recentTasks.find(
                            (candidate) => candidate.threadId === navigation.threadId,
                          );
                          if (task === undefined) {
                            return { ...current, updatedAt: event.createdAt };
                          }
                          if (current.focusedThreadId === task.threadId) {
                            return {
                              ...current,
                              attentionThreadId: null,
                              newConversationArmed: false,
                              updatedAt: event.createdAt,
                            };
                          }
                          return {
                            ...current,
                            focusedThreadId: task.threadId,
                            attentionThreadId: null,
                            backStack:
                              current.focusedThreadId === null
                                ? current.backStack
                                : retainLatestThreadIds([
                                    ...current.backStack,
                                    current.focusedThreadId,
                                  ]),
                            forwardStack: [],
                            recentTasks: prioritizeTask(current.recentTasks, task),
                            newConversationArmed: false,
                            updatedAt: event.createdAt,
                          };
                        }
                        const source =
                          navigation.action === "back" ? current.backStack : current.forwardStack;
                        const validSource = source.filter((threadId) =>
                          current.recentTasks.some((task) => task.threadId === threadId),
                        );
                        const target = validSource[validSource.length - 1];
                        if (target === undefined) return { ...current, updatedAt: event.createdAt };
                        const destination = current.recentTasks.find(
                          (task) => task.threadId === target,
                        );
                        if (destination === undefined)
                          return { ...current, updatedAt: event.createdAt };
                        const opposite =
                          current.focusedThreadId === null
                            ? navigation.action === "back"
                              ? current.forwardStack.filter((threadId) =>
                                  current.recentTasks.some((task) => task.threadId === threadId),
                                )
                              : current.backStack.filter((threadId) =>
                                  current.recentTasks.some((task) => task.threadId === threadId),
                                )
                            : retainLatestThreadIds([
                                ...(navigation.action === "back"
                                  ? current.forwardStack.filter((threadId) =>
                                      current.recentTasks.some(
                                        (task) => task.threadId === threadId,
                                      ),
                                    )
                                  : current.backStack.filter((threadId) =>
                                      current.recentTasks.some(
                                        (task) => task.threadId === threadId,
                                      ),
                                    )),
                                current.focusedThreadId,
                              ]);
                        return {
                          ...current,
                          focusedThreadId: target,
                          backStack:
                            navigation.action === "back" ? validSource.slice(0, -1) : opposite,
                          forwardStack:
                            navigation.action === "forward" ? validSource.slice(0, -1) : opposite,
                          attentionThreadId: null,
                          recentTasks: prioritizeTask(current.recentTasks, destination),
                          newConversationArmed: false,
                          updatedAt: event.createdAt,
                        };
                      })()
                    : event.type === "clarification-set"
                      ? { ...current, pendingFrame: event.frame, updatedAt: event.createdAt }
                      : (() => {
                          const task =
                            event.threadId === null
                              ? undefined
                              : current.recentTasks.find(
                                  (candidate) => candidate.threadId === event.threadId,
                                );
                          return {
                            ...current,
                            pendingFrame: null,
                            ...(task === undefined
                              ? {}
                              : {
                                  focusedThreadId: task.threadId,
                                  attentionThreadId: null,
                                  recentTasks: prioritizeTask(current.recentTasks, task),
                                  newConversationArmed: false,
                                }),
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
            return { previous: current, next };
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
      return (yield* persistEvent(input.sessionId, {
        type: "task-focused",
        task: input.task,
        createdAt: yield* DateTime.now,
      })).next;
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
          }).pipe(Effect.asVoid),
        { concurrency: 1, discard: true },
      );
    });

    const navigate = Effect.fn("JarvisTaskDesk.navigate")(function* (input: {
      readonly sessionId: AuthSessionId;
      readonly navigation: JarvisTaskDeskNavigation;
    }) {
      return (yield* persistEvent(input.sessionId, {
        type: "navigation-applied",
        navigation: input.navigation,
        createdAt: yield* DateTime.now,
      })).next;
    });

    const consumeNewConversation = Effect.fn("JarvisTaskDesk.consumeNewConversation")(function* (
      sessionId: AuthSessionId,
    ) {
      const result = yield* persistEvent(sessionId, {
        type: "navigation-applied",
        navigation: { action: "cancel-new-conversation" },
        createdAt: yield* DateTime.now,
      });
      return result.previous.newConversationArmed;
    });

    const setClarification = Effect.fn("JarvisTaskDesk.setClarification")(function* (input: {
      readonly sessionId: AuthSessionId;
      readonly frame: import("@t3tools/contracts").JarvisTaskClarificationFrame;
    }) {
      return (yield* persistEvent(input.sessionId, {
        type: "clarification-set",
        frame: input.frame,
        createdAt: yield* DateTime.now,
      })).next;
    });

    const resolveClarification = Effect.fn("JarvisTaskDesk.resolveClarification")(
      function* (input: { readonly sessionId: AuthSessionId; readonly threadId: ThreadId | null }) {
        return (yield* persistEvent(input.sessionId, {
          type: "clarification-resolved",
          threadId: input.threadId,
          createdAt: yield* DateTime.now,
        })).next;
      },
    );

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

    return JarvisTaskDesk.of({
      get,
      focus,
      navigate,
      consumeNewConversation,
      setClarification,
      resolveClarification,
      observeLifecycle,
      listTrackedThreadIds,
    });
  }),
);
