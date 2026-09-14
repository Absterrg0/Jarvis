// @effect-diagnostics nodeBuiltinImport:off - the test creates and removes a real temp directory.
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ForeignDatabaseError, runMigrations } from "./Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const isForeignDatabaseError = Schema.is(ForeignDatabaseError);

/**
 * A database that stopped before Circe's fork point records only migrations
 * 1-40, whose names are identical on the T3 Code and Circe lines. Without a
 * Circe ownership marker it must not be adopted.
 */
layer("Unowned database", (it) => {
  it.effect("refuses an unmarked database that predates Circe's slots", () =>
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
        VALUES (1, 'OrchestrationEvents')
      `;

      const baseDir = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-unowned-")),
      );
      const exit = yield* Effect.exit(runMigrations({ baseDir }));
      yield* Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        const die = exit.cause.reasons.find(Cause.isDieReason);
        const defect = die?.defect;
        assert.isTrue(isForeignDatabaseError(defect));
        if (isForeignDatabaseError(defect)) {
          assert.equal(defect.reason, "unowned_database");
        }
      }
    }),
  );
});
