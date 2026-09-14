import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ForeignDatabaseError, runMigrations } from "./Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const isForeignDatabaseError = Schema.is(ForeignDatabaseError);

/**
 * The CLI and server historically defaulted to `~/.t3`, which is the separate
 * T3 Code product's home. Opening that database runs Circe's renumbered
 * migrations against an upstream history and fails midway. The runner must
 * refuse before applying anything.
 */
layer("Foreign database guard", (it) => {
  it.effect("refuses to migrate a database recorded by another product", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE effect_sql_migrations (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (50, 'ProjectionProjectsAutoPull')
      `;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        const die = exit.cause.reasons.find(Cause.isDieReason);
        assert.isTrue(isForeignDatabaseError(die?.defect));
      }
    }),
  );
});
