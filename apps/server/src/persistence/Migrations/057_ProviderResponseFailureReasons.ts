import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const closedRequestPattern = (path: string): string => `
  lower(COALESCE(json_extract(payload_json, '${path}'), '')) LIKE '%stale pending approval request%'
  OR lower(COALESCE(json_extract(payload_json, '${path}'), '')) LIKE '%unknown pending approval request%'
  OR lower(COALESCE(json_extract(payload_json, '${path}'), '')) LIKE '%unknown pending permission request%'
  OR lower(COALESCE(json_extract(payload_json, '${path}'), '')) LIKE '%stale pending user-input request%'
  OR lower(COALESCE(json_extract(payload_json, '${path}'), '')) LIKE '%unknown pending user-input request%'
  OR lower(COALESCE(json_extract(payload_json, '${path}'), '')) LIKE '%unknown pending user input request%'
  OR lower(COALESCE(json_extract(payload_json, '${path}'), '')) LIKE '%unknown pending codex user input request%'
`;

/** Give historical provider-response failures the structured reason emitted by current code. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
    UPDATE projection_thread_activities
    SET payload_json = json_set(payload_json, '$.failureReason', 'request-closed')
    WHERE kind IN ('provider.approval.respond.failed', 'provider.user-input.respond.failed')
      AND json_extract(payload_json, '$.failureReason') IS NULL
      AND (${closedRequestPattern("$.detail")})
  `);
  yield* sql.unsafe(`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.activity.payload.failureReason',
      'request-closed'
    )
    WHERE event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.kind') IN (
        'provider.approval.respond.failed',
        'provider.user-input.respond.failed'
      )
      AND json_extract(payload_json, '$.activity.payload.failureReason') IS NULL
      AND (${closedRequestPattern("$.activity.payload.detail")})
  `);
});
