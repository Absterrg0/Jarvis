import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE jarvis_task_desks
    SET desk_json = json_set(desk_json, '$.pendingFrame', NULL)
    WHERE json_type(desk_json, '$.pendingFrame') IS NULL
  `;
});
