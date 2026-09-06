import { AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { JarvisPushRegistrationRepository } from "../Services/JarvisPushRegistrations.ts";
import { JarvisPushRegistrationsLive } from "./JarvisPushRegistrations.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(
    JarvisPushRegistrationsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const session = (id: string) => AuthSessionId.make(id);

function insertSession(sql: SqlClient.SqlClient, id: string) {
  return sql`INSERT INTO auth_sessions (
    session_id, subject, scopes, method, issued_at, expires_at
  ) VALUES (
    ${id}, 'mobile', '["orchestration:read"]', 'bearer',
    '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
  )`;
}

layer("JarvisPushRegistrations replacement", (it) => {
  it.effect("replaces the token on rotation for the same device", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const registrations = yield* JarvisPushRegistrationRepository;
      const nodeId = EnvironmentId.make("node-rotation");
      yield* insertSession(sql, "session-rotation-1");
      yield* insertSession(sql, "session-rotation-2");

      yield* registrations.register({
        token: "ExponentPushToken[one]",
        deviceId: "device-rotation",
        sessionId: session("session-rotation-1"),
        nodeId,
        updatedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
      });
      yield* registrations.register({
        token: "ExponentPushToken[two]",
        deviceId: "device-rotation",
        sessionId: session("session-rotation-2"),
        nodeId,
        updatedAt: "2026-09-02T00:00:00.000Z",
        expiresAt: "2026-10-02T00:00:00.000Z",
      });

      const rows = yield* registrations.listByNode({ nodeId });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.token, "ExponentPushToken[two]");
    }),
  );

  it.effect("moves a reused token to the newest device", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const registrations = yield* JarvisPushRegistrationRepository;
      const nodeId = EnvironmentId.make("node-reuse");
      yield* insertSession(sql, "session-reuse-1");
      yield* insertSession(sql, "session-reuse-2");

      yield* registrations.register({
        token: "ExponentPushToken[shared]",
        deviceId: "device-old",
        sessionId: session("session-reuse-1"),
        nodeId,
        updatedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
      });
      yield* registrations.register({
        token: "ExponentPushToken[shared]",
        deviceId: "device-new",
        sessionId: session("session-reuse-2"),
        nodeId,
        updatedAt: "2026-09-02T00:00:00.000Z",
        expiresAt: "2026-10-02T00:00:00.000Z",
      });

      const rows = yield* registrations.listByNode({ nodeId });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.deviceId, "device-new");
    }),
  );

  it.effect("keeps the last concurrent replacement for one device", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const registrations = yield* JarvisPushRegistrationRepository;
      const nodeId = EnvironmentId.make("node-concurrent");
      yield* insertSession(sql, "session-concurrent-1");
      yield* insertSession(sql, "session-concurrent-2");

      yield* Effect.forEach(
        ["ExponentPushToken[a]", "ExponentPushToken[b]"] as const,
        (token, index) =>
          registrations.register({
            token,
            deviceId: "device-concurrent",
            sessionId: session(`session-concurrent-${index + 1}`),
            nodeId,
            updatedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
            expiresAt: "2026-10-01T00:00:00.000Z",
          }),
        { concurrency: 2 },
      );

      const rows = yield* registrations.listByNode({ nodeId });
      assert.strictEqual(rows.length, 1);
    }),
  );

  it.effect("removes only the unchanged version on stale invalidation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const registrations = yield* JarvisPushRegistrationRepository;
      const nodeId = EnvironmentId.make("node-stale");
      yield* insertSession(sql, "session-stale-1");

      yield* registrations.register({
        token: "ExponentPushToken[stale]",
        deviceId: "device-stale",
        sessionId: session("session-stale-1"),
        nodeId,
        updatedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
      });
      const removed = yield* registrations.unregisterIfUnchanged({
        token: "ExponentPushToken[stale]",
        deviceId: "device-stale",
        sessionId: session("session-stale-1"),
        updatedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
      });
      assert.strictEqual(removed, true);
      assert.deepStrictEqual(yield* registrations.listByNode({ nodeId }), []);

      yield* registrations.register({
        token: "ExponentPushToken[renewed]",
        deviceId: "device-renewed",
        sessionId: session("session-stale-1"),
        nodeId,
        updatedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
      });
      yield* registrations.register({
        token: "ExponentPushToken[renewed]",
        deviceId: "device-renewed",
        sessionId: session("session-stale-1"),
        nodeId,
        updatedAt: "2026-09-02T00:00:00.000Z",
        expiresAt: "2026-10-02T00:00:00.000Z",
      });
      const staleRemoved = yield* registrations.unregisterIfUnchanged({
        token: "ExponentPushToken[renewed]",
        deviceId: "device-renewed",
        sessionId: session("session-stale-1"),
        updatedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
      });
      assert.strictEqual(staleRemoved, false);
      const rows = yield* registrations.listByNode({ nodeId });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.updatedAt, "2026-09-02T00:00:00.000Z");
    }),
  );
});
