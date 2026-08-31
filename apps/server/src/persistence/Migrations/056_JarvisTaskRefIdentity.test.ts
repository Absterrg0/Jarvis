// @effect-diagnostics preferSchemaOverJson:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055-056 Jarvis identity cleanup", (it) => {
  it.effect("preserves queued work and rewrites task refs to node-qualified thread identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO jarvis_follow_up_queue(
          queue_id, dispatch_identity, thread_id, project_id, provider_id,
          instruction, status, enqueued_at, updated_at
        ) VALUES (
          'queue-one', 'jarvis:queue:dispatch:queue-one', 'thread-one', 'project-one', 'codex',
          'Continue', 'pending', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO jarvis_task_desks(session_id, desk_json, updated_at)
        VALUES (
          'session-one',
          ${JSON.stringify({
            focusedTask: {
              threadId: "thread-one",
              taskRef: {
                executionNodeId: "node-one",
                remoteTaskId: "thread-one",
                remoteThreadId: "thread-one",
                projectId: "project-one",
                providerId: "codex",
              },
              projectRef: { nodeId: "node-one", projectId: "project-one" },
            },
            recentTasks: [
              {
                threadId: "thread-one",
                taskRef: {
                  executionNodeId: "node-one",
                  remoteTaskId: "thread-one",
                  remoteThreadId: "thread-one",
                  projectId: "project-one",
                  providerId: "codex",
                },
                projectRef: { nodeId: "node-one", projectId: "project-one" },
              },
            ],
            pendingInteraction: {
              kind: "task",
              frame: {
                originalUtterance: "Stop the task",
                candidates: [
                  {
                    threadId: "thread-one",
                    taskRef: {
                      executionNodeId: "node-one",
                      remoteTaskId: "thread-one",
                      remoteThreadId: "thread-one",
                    },
                    label: "Task one",
                  },
                ],
                createdAt: "2026-08-30T00:00:00.000Z",
                expiresAt: "2026-08-30T00:05:00.000Z",
              },
            },
            updatedAt: "2026-08-30T00:00:00.000Z",
          })},
          '2026-08-30T00:00:00.000Z'
        )
      `;
      const oldActivityPayload = JSON.stringify({
        objective: "Continue",
        taskRef: {
          executionNodeId: "node-one",
          remoteTaskId: "thread-one",
          remoteThreadId: "thread-one",
          projectId: "project-one",
          providerId: "codex",
        },
        requestMetadata: { requestId: "request-one" },
      });
      yield* sql`
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'activity-one', 'thread-one', NULL, 'info', 'jarvis.task.created', 'Created',
          ${oldActivityPayload}, '2026-08-30T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events(
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-one', 'thread', 'thread-one', 1, 'thread.activity-appended',
          '2026-08-30T00:00:00.000Z', 'command-one', NULL, NULL, 'system',
          ${JSON.stringify({
            threadId: "thread-one",
            activity: {
              id: "activity-one",
              tone: "info",
              kind: "jarvis.task.created",
              summary: "Created",
              payload: JSON.parse(oldActivityPayload),
              turnId: null,
              createdAt: "2026-08-30T00:00:00.000Z",
            },
          })},
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 56 });

      const queued = yield* sql<{ readonly queueId: string; readonly instruction: string }>`
        SELECT queue_id AS queueId, instruction FROM jarvis_follow_up_queue
      `;
      assert.deepEqual(queued, [{ queueId: "queue-one", instruction: "Continue" }]);
      const queueColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('jarvis_follow_up_queue')
      `;
      assert.isFalse(
        queueColumns.some(({ name }) =>
          ["dispatch_identity", "project_id", "execution_node_id", "provider_id"].includes(name),
        ),
      );

      const desks = yield* sql<{ readonly deskJson: string }>`
        SELECT desk_json AS deskJson FROM jarvis_task_desks WHERE session_id = 'session-one'
      `;
      const desk = JSON.parse(desks[0]!.deskJson);
      assert.deepEqual(desk.focusedTask.taskRef, {
        executionNodeId: "node-one",
        threadId: "thread-one",
      });
      assert.deepEqual(desk.pendingInteraction.frame.candidates[0].taskRef, {
        executionNodeId: "node-one",
        threadId: "thread-one",
      });

      const activities = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS payloadJson
        FROM projection_thread_activities
        WHERE activity_id = 'activity-one'
      `;
      assert.deepEqual(JSON.parse(activities[0]!.payloadJson).taskRef, {
        executionNodeId: "node-one",
        threadId: "thread-one",
      });
      const events = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS payloadJson
        FROM orchestration_events
        WHERE event_id = 'event-one'
      `;
      assert.deepEqual(JSON.parse(events[0]!.payloadJson).activity.payload.taskRef, {
        executionNodeId: "node-one",
        threadId: "thread-one",
      });
    }),
  );
});
