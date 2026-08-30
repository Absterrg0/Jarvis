import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_JarvisProjectAliasCurrentState", (it) => {
  it.effect("drops alias history while preserving current aliases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* sql`
        INSERT INTO jarvis_project_aliases(project_id, normalized_alias, alias, kind, updated_at)
        VALUES ('project-rivvl', 'ripple', 'Ripple', 'confirmed-pronunciation', '2026-08-30T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO jarvis_project_alias_events(project_id, event_json, created_at)
        VALUES ('project-rivvl', '{"type":"project-alias-learned"}', '2026-08-30T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const aliases = yield* sql<{
        readonly projectId: string;
        readonly normalizedAlias: string;
        readonly alias: string;
      }>`
        SELECT project_id AS projectId, normalized_alias AS normalizedAlias, alias
        FROM jarvis_project_aliases
      `;
      assert.deepEqual(aliases, [
        { projectId: "project-rivvl", normalizedAlias: "ripple", alias: "Ripple" },
      ]);

      const history = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jarvis_project_alias_events'
      `;
      assert.deepEqual(history, []);
    }),
  );
});
