import {
  EnvironmentId,
  IsoDateTime,
  JarvisPushDeviceId,
  JarvisPushToken,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import {
  JarvisPushRegistration,
  JarvisPushRegistrationRepository,
} from "../Services/JarvisPushRegistrations.ts";

const PushRegistrationDbRow = Schema.Struct({
  token: JarvisPushToken,
  deviceId: JarvisPushDeviceId,
  sessionId: AuthSessionId,
  nodeId: EnvironmentId,
  updatedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});

export const JarvisPushRegistrationsLive = Layer.effect(
  JarvisPushRegistrationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const insert = SqlSchema.void({
      Request: JarvisPushRegistration,
      execute: (input) =>
        sql.withTransaction(
          sql`
          DELETE FROM jarvis_push_registrations
          WHERE token = ${input.token} OR device_id = ${input.deviceId}
        `.pipe(
            Effect.andThen(sql`
            INSERT INTO jarvis_push_registrations
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
        token: JarvisPushToken,
        deviceId: JarvisPushDeviceId,
        sessionId: AuthSessionId,
      }),
      Result: Schema.Struct({ removed: Schema.Number }),
      execute: (input) => sql`
        DELETE FROM jarvis_push_registrations
        WHERE token = ${input.token}
          AND device_id = ${input.deviceId}
          AND session_id = ${input.sessionId}
        RETURNING 1 AS removed
      `,
    });
    const list = SqlSchema.findAll({
      Request: Schema.Struct({ nodeId: EnvironmentId }),
      Result: PushRegistrationDbRow,
      execute: (input) => sql`
        SELECT token, device_id AS "deviceId", session_id AS "sessionId",
          node_id AS "nodeId", updated_at AS "updatedAt", expires_at AS "expiresAt"
        FROM jarvis_push_registrations
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
      listByNode: (input) => list(input).pipe(Effect.mapError(mapError("push.listByNode"))),
    };
  }),
);
