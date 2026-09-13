import { CirceProjectAlias, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  isPersistenceError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "../../persistence/Errors.ts";
import { CirceProjectLexicon } from "../Services/CirceProjectLexicon.ts";

const MAX_ALIASES_PER_PROJECT = 20;

const normalizeAlias = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");

const AliasRow = Schema.Struct({
  projectId: ProjectId,
  alias: Schema.String,
  kind: CirceProjectAlias.fields.kind,
  updatedAt: Schema.DateTimeUtcFromString,
});
const decodeAliasRows = Schema.decodeUnknownEffect(Schema.Array(AliasRow));
const toPersistenceError =
  (operation: string, _correlation?: Record<string, unknown>) => (cause: unknown) =>
    isPersistenceError(cause)
      ? cause
      : Schema.isSchemaError(cause)
        ? PersistenceDecodeError.fromSchemaError(operation, cause)
        : new PersistenceSqlError({ operation, cause });

export const CirceProjectLexiconLive = Layer.effect(
  CirceProjectLexicon,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const list = Effect.fn("CirceProjectLexicon.list")(function* () {
      const rows = yield* sql<{
        readonly projectId: string;
        readonly alias: string;
        readonly kind: CirceProjectAlias["kind"];
        readonly updatedAt: string;
      }>`
        SELECT project_id AS projectId, alias, kind, updated_at AS updatedAt
        FROM circe_project_aliases
        ORDER BY updated_at DESC, project_id, normalized_alias
      `.pipe(Effect.mapError(toPersistenceError("CirceProjectLexicon.list:query")));
      return yield* decodeAliasRows(rows).pipe(
        Effect.map((aliases) => aliases as ReadonlyArray<CirceProjectAlias>),
        Effect.mapError(toPersistenceError("CirceProjectLexicon.list:decode")),
      );
    });

    const learn = Effect.fn("CirceProjectLexicon.learn")(function* (input: {
      readonly projectId: ProjectId;
      readonly alias: string;
      readonly kind: CirceProjectAlias["kind"];
    }) {
      const normalized = normalizeAlias(input.alias);
      if (normalized.length === 0 || normalized.length > 200) {
        return yield* new PersistenceDecodeError({
          operation: "CirceProjectLexicon.learn:alias",
          issue: "A learned project alias must contain 1 to 200 normalized characters.",
        });
      }
      const now = yield* DateTime.now;
      const alias: CirceProjectAlias = {
        projectId: input.projectId,
        alias: input.alias.trim(),
        kind: input.kind,
        updatedAt: now,
      };
      const nowIso = DateTime.formatIso(now);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
            INSERT INTO circe_project_aliases(project_id, normalized_alias, alias, kind, updated_at)
            VALUES (${input.projectId}, ${normalized}, ${alias.alias}, ${input.kind}, ${nowIso})
            ON CONFLICT(project_id, normalized_alias) DO UPDATE SET
              alias = excluded.alias,
              kind = CASE
                WHEN circe_project_aliases.kind = 'user-defined' THEN circe_project_aliases.kind
                ELSE excluded.kind
              END,
              updated_at = excluded.updated_at
          `;
            yield* sql`
            DELETE FROM circe_project_aliases
            WHERE project_id = ${input.projectId}
              AND normalized_alias NOT IN (
                SELECT normalized_alias
                FROM circe_project_aliases
                WHERE project_id = ${input.projectId}
                ORDER BY updated_at DESC, rowid DESC
                LIMIT ${MAX_ALIASES_PER_PROJECT}
              )
          `;
          }),
        )
        .pipe(
          Effect.mapError(
            toPersistenceError("CirceProjectLexicon.learn:persist", {
              projectId: input.projectId,
            }),
          ),
        );
      return alias;
    });

    const forget = Effect.fn("CirceProjectLexicon.forget")(function* (input: {
      readonly projectId: ProjectId;
      readonly alias: string;
    }) {
      const normalized = normalizeAlias(input.alias);
      if (normalized.length === 0) return false;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM circe_project_aliases
              WHERE project_id = ${input.projectId} AND normalized_alias = ${normalized}
            `;
            if ((existing[0]?.count ?? 0) === 0) return false;
            yield* sql`
              DELETE FROM circe_project_aliases
              WHERE project_id = ${input.projectId} AND normalized_alias = ${normalized}
            `;
            return true;
          }),
        )
        .pipe(
          Effect.mapError(
            toPersistenceError("CirceProjectLexicon.forget:persist", {
              projectId: input.projectId,
            }),
          ),
        );
    });

    return CirceProjectLexicon.of({ list, learn, forget });
  }),
);
