import {
  EnvironmentId,
  IsoDateTime,
  CircePushDeviceId,
  CircePushToken,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import {
  CircePushRegistration,
  CircePushRegistrationRepository,
} from "../Services/CircePushRegistrations.ts";

const PushRegistrationDbRow = Schema.Struct({
  token: CircePushToken,
  deviceId: CircePushDeviceId,
  sessionId: AuthSessionId,
  nodeId: EnvironmentId,
  updatedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});

export const CircePushRegistrationsLive = Layer.effect(
  CircePushRegistrationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const insert = SqlSchema.void({
      Request: CircePushRegistration,
      execute: (input) =>
        sql.withTransaction(
          sql`
          DELETE FROM circe_push_registrations
          WHERE token = ${input.token} OR device_id = ${input.deviceId}
        `.pipe(
            Effect.andThen(sql`
            INSERT INTO circe_push_registrations
              (token, device_id, session_id, node_id, updated_at, expires_at)
            VALUES
              (${input.token}, ${input.deviceId}, ${input.sessionId}, ${input.nodeId},
                ${input.updatedAt}, ${input.expiresAt})
          `),
          ),
        ),
    });
    const remove = SqlSchema.findAll({
      Request: Schema.Struct({
        token: CircePushToken,
        deviceId: CircePushDeviceId,
        sessionId: AuthSessionId,
      }),
      Result: Schema.Struct({ removed: Schema.Number }),
      execute: (input) => sql`
        DELETE FROM circe_push_registrations
        WHERE token = ${input.token}
          AND device_id = ${input.deviceId}
          AND session_id = ${input.sessionId}
        RETURNING 1 AS removed
      `,
    });
    const removeIfUnchanged = SqlSchema.findAll({
      Request: Schema.Struct({
        token: CircePushToken,
        deviceId: CircePushDeviceId,
        sessionId: AuthSessionId,
        updatedAt: IsoDateTime,
        expiresAt: IsoDateTime,
      }),
      Result: Schema.Struct({ removed: Schema.Number }),
      execute: (input) => sql`
        DELETE FROM circe_push_registrations
        WHERE token = ${input.token}
          AND device_id = ${input.deviceId}
          AND session_id = ${input.sessionId}
          AND updated_at = ${input.updatedAt}
          AND expires_at = ${input.expiresAt}
        RETURNING 1 AS removed
      `,
    });
    const list = SqlSchema.findAll({
      Request: Schema.Struct({ nodeId: EnvironmentId }),
      Result: PushRegistrationDbRow,
      execute: (input) => sql`
        SELECT token, device_id AS "deviceId", session_id AS "sessionId",
          node_id AS "nodeId", updated_at AS "updatedAt", expires_at AS "expiresAt"
        FROM circe_push_registrations
        WHERE node_id = ${input.nodeId}
      `,
    });
    const mapError = (operation: string) => (cause: unknown) =>
      Schema.isSchemaError(cause)
        ? PersistenceDecodeError.fromSchemaError(operation, cause)
        : new PersistenceSqlError({ operation, cause });

    return {
      register: (input) => insert(input).pipe(Effect.mapError(mapError("push.register"))),
      unregister: (input) =>
        remove(input).pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(mapError("push.unregister")),
        ),
      unregisterIfUnchanged: (input) =>
        removeIfUnchanged(input).pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(mapError("push.unregisterIfUnchanged")),
        ),
      listByNode: (input) => list(input).pipe(Effect.mapError(mapError("push.listByNode"))),
    };
  }),
);
