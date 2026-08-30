import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Collapse the old task-desk event stream into the current session snapshot.
 *
 * Task lifecycle and blocking attention are T3 projection data, so the desk
 * keeps only navigation identity and an optional dialogue frame. The
 * migration is deliberately one-way: old event rows are no longer part of
 * the runtime contract once every existing snapshot has been rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE jarvis_task_desks
    SET desk_json = json_object(
      'focusedThreadId', json_extract(desk_json, '$.focusedThreadId'),
      'recentTasks', COALESCE(
        (
          SELECT json_group_array(
            CASE
              WHEN json_type(task.value, '$.taskRef') IS NULL THEN
                json_object('threadId', json_extract(task.value, '$.threadId'))
              ELSE
                json_object(
                  'threadId', json_extract(task.value, '$.threadId'),
                  'taskRef', json_extract(task.value, '$.taskRef')
                )
            END
          )
          FROM json_each(desk_json, '$.recentTasks') AS task
        ),
        json('[]')
      ),
      'pendingInteraction', CASE
        WHEN json_type(desk_json, '$.pendingProjectFrame') = 'object' THEN
          json_object('kind', 'project', 'frame', json_extract(desk_json, '$.pendingProjectFrame'))
        WHEN json_type(desk_json, '$.pendingFrame') = 'object' THEN
          json_object('kind', 'task', 'frame', json_extract(desk_json, '$.pendingFrame'))
        ELSE NULL
      END,
      'updatedAt', json_extract(desk_json, '$.updatedAt')
    )
  `;

  yield* sql`DROP TABLE IF EXISTS jarvis_task_desk_events`;
});
