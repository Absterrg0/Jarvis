// @effect-diagnostics preferSchemaOverJson:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057 provider response failure reasons", (it) => {
  it.effect("backfills closed-request reasons in projections and durable events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      const activityPayload = {
        requestId: "request-one",
        detail: "Unknown pending approval request request-one",
      };
      yield* sql`
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'activity-one', 'thread-one', NULL, 'error', 'provider.approval.respond.failed',
          'Provider approval response failed', ${JSON.stringify(activityPayload)},
          '2026-08-31T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events(
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-one', 'thread', 'thread-one', 1, 'thread.activity-appended',
          '2026-08-31T00:00:00.000Z', 'command-one', NULL, NULL, 'system',
          ${JSON.stringify({
            threadId: "thread-one",
            activity: {
              id: "activity-one",
              tone: "error",
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              payload: activityPayload,
              turnId: null,
              createdAt: "2026-08-31T00:00:00.000Z",
            },
          })},
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 57 });

      const activities = yield* sql<{ readonly reason: string }>`
        SELECT json_extract(payload_json, '$.failureReason') AS reason
        FROM projection_thread_activities
        WHERE activity_id = 'activity-one'
      `;
      const events = yield* sql<{ readonly reason: string }>`
        SELECT json_extract(payload_json, '$.activity.payload.failureReason') AS reason
        FROM orchestration_events
        WHERE event_id = 'event-one'
      `;
      assert.deepEqual(activities, [{ reason: "request-closed" }]);
      assert.deepEqual(events, [{ reason: "request-closed" }]);
    }),
  );
});
