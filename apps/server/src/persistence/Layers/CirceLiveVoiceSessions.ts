import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  CirceLiveVoiceSessionLease,
  CirceLiveVoiceSessionRepository,
} from "../Services/CirceLiveVoiceSessions.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const CirceLiveVoiceSessionsLive = Layer.effect(
  CirceLiveVoiceSessionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const put = SqlSchema.void({
      Request: CirceLiveVoiceSessionLease,
      execute: (lease) => sql`
        INSERT INTO circe_live_voice_sessions (session_id, environment_id, created_at, deadline_at)
        VALUES (${lease.sessionId}, ${lease.environmentId}, ${lease.createdAt}, ${lease.deadlineAt})
        ON CONFLICT (session_id) DO UPDATE SET
          environment_id = excluded.environment_id,
          created_at = excluded.created_at,
          deadline_at = excluded.deadline_at
      `,
    });

    const list = SqlSchema.findAll({
      Request: Schema.Struct({}),
      Result: CirceLiveVoiceSessionLease,
      execute: () => sql`
        SELECT session_id AS "sessionId", environment_id AS "environmentId",
          created_at AS "createdAt", deadline_at AS "deadlineAt"
        FROM circe_live_voice_sessions
      `,
    });

    const remove = SqlSchema.findAll({
      Request: Schema.Struct({ sessionId: TrimmedNonEmptyString }),
      Result: Schema.Struct({ removed: Schema.Number }),
      execute: (input) => sql`
        DELETE FROM circe_live_voice_sessions
        WHERE session_id = ${input.sessionId}
        RETURNING 1 AS removed
      `,
    });

    const mapError = (operation: string) => (cause: unknown) =>
      Schema.isSchemaError(cause)
        ? PersistenceDecodeError.fromSchemaError(operation, cause)
        : new PersistenceSqlError({ operation, cause });

    return CirceLiveVoiceSessionRepository.of({
      list: () => list({}).pipe(Effect.mapError(mapError("liveVoiceLeases.list"))),
      put: (lease) => put(lease).pipe(Effect.mapError(mapError("liveVoiceLeases.put"))),
      remove: (input) =>
        remove(input).pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(mapError("liveVoiceLeases.remove")),
        ),
    });
  }),
);
