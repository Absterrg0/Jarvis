import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("058_JarvisPushRegistrations", (it) => {
  it.effect("stores node-scoped registrations and removes them with the auth session", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, scopes, method, issued_at, expires_at
        ) VALUES (
          'session-1', 'mobile', '["orchestration:read"]', 'bearer',
          '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO jarvis_push_registrations (
          token, device_id, session_id, node_id, updated_at, expires_at
        ) VALUES (
          'ExponentPushToken[test]', 'device-1', 'session-1', 'desktop',
          '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
        )
      `;

      const rows = yield* sql<{ readonly nodeId: string }>`
        SELECT node_id AS "nodeId" FROM jarvis_push_registrations
      `;
      assert.deepStrictEqual(rows, [{ nodeId: "desktop" }]);

      yield* sql`DELETE FROM auth_sessions WHERE session_id = 'session-1'`;
      const remaining = yield* sql`SELECT token FROM jarvis_push_registrations`;
      assert.deepStrictEqual(remaining, []);
    }),
  );
});
