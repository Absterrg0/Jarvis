import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("066_CirceLiveVoiceSessions", (it) => {
  it.effect("stores a local live voice lease with an integer ceiling", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`
        INSERT INTO circe_live_voice_sessions
          (session_id, environment_id, created_at, deadline_at)
        VALUES ('live_1', 'node-1', 1000, 2000)
      `;
      const rows = yield* sql<{
        readonly sessionId: string;
        readonly environmentId: string;
        readonly deadlineAt: number;
      }>`
        SELECT session_id AS "sessionId", environment_id AS "environmentId",
          deadline_at AS "deadlineAt"
        FROM circe_live_voice_sessions
      `;
      assert.deepStrictEqual(rows, [
        { sessionId: "live_1", environmentId: "node-1", deadlineAt: 2000 },
      ]);
    }),
  );
});
