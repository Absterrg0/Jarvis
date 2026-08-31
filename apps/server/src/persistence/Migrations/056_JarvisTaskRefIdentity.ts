import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE jarvis_task_desks
    SET desk_json = json_object(
      'focusedTask', CASE
        WHEN json_type(desk_json, '$.focusedTask') = 'object' THEN json_object(
          'threadId', json_extract(desk_json, '$.focusedTask.threadId'),
          'taskRef', json_object(
            'executionNodeId', json_extract(desk_json, '$.focusedTask.taskRef.executionNodeId'),
            'threadId', json_extract(desk_json, '$.focusedTask.threadId')
          ),
          'projectRef', json_extract(desk_json, '$.focusedTask.projectRef')
        )
        ELSE NULL
      END,
      'recentTasks', COALESCE(
        (
          SELECT json_group_array(
            json_object(
              'threadId', json_extract(task.value, '$.threadId'),
              'taskRef', json_object(
                'executionNodeId', json_extract(task.value, '$.taskRef.executionNodeId'),
                'threadId', json_extract(task.value, '$.threadId')
              ),
              'projectRef', json_extract(task.value, '$.projectRef')
            )
          )
          FROM json_each(desk_json, '$.recentTasks') AS task
        ),
        json('[]')
      ),
      'pendingInteraction', json_extract(desk_json, '$.pendingInteraction'),
      'updatedAt', json_extract(desk_json, '$.updatedAt')
    )
  `;

  yield* sql`
    UPDATE jarvis_task_desks
    SET desk_json = json_set(
      desk_json,
      '$.pendingInteraction.frame.candidates',
      COALESCE(
        (
          SELECT json_group_array(
            CASE
              WHEN json_type(candidate.value, '$.taskRef') = 'object' THEN json_set(
                candidate.value,
                '$.taskRef',
                json_object(
                  'executionNodeId', json_extract(candidate.value, '$.taskRef.executionNodeId'),
                  'threadId', json_extract(candidate.value, '$.threadId')
                )
              )
              ELSE candidate.value
            END
          )
          FROM json_each(desk_json, '$.pendingInteraction.frame.candidates') AS candidate
        ),
        json('[]')
      )
    )
    WHERE json_extract(desk_json, '$.pendingInteraction.kind') = 'task'
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET payload_json = json_set(
      payload_json,
      '$.taskRef',
      json_object(
        'executionNodeId', json_extract(payload_json, '$.taskRef.executionNodeId'),
        'threadId', COALESCE(
          json_extract(payload_json, '$.taskRef.remoteThreadId'),
          json_extract(payload_json, '$.taskRef.remoteTaskId'),
          thread_id
        )
      )
    )
    WHERE kind IN ('jarvis.task.created', 'jarvis.review.source')
      AND json_type(payload_json, '$.taskRef') = 'object'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.activity.payload.taskRef',
      json_object(
        'executionNodeId', json_extract(
          payload_json,
          '$.activity.payload.taskRef.executionNodeId'
        ),
        'threadId', COALESCE(
          json_extract(payload_json, '$.activity.payload.taskRef.remoteThreadId'),
          json_extract(payload_json, '$.activity.payload.taskRef.remoteTaskId'),
          json_extract(payload_json, '$.threadId')
        )
      )
    )
    WHERE event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.kind') IN (
        'jarvis.task.created',
        'jarvis.review.source'
      )
      AND json_type(payload_json, '$.activity.payload.taskRef') = 'object'
  `;
});
