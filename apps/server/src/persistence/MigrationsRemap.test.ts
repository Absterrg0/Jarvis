import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

/**
 * IDs 41-58 shipped on the ARIS line and are never renumbered. Upstream
 * migrations that landed after the fork point (upstream 044-050) are
 * re-registered above 58 so every migration applies exactly once.
 */
const EXPECTED_MANIFEST: ReadonlyArray<readonly [number, string]> = [
  [41, "JarvisTaskDesks"],
  [42, "JarvisTaskDeskAttention"],
  [43, "JarvisTaskDeskClarification"],
  [44, "JarvisProjectClarification"],
  [45, "JarvisProjectAliases"],
  [46, "JarvisReportOutbox"],
  [47, "AuthSessionClientConnection"],
  [48, "ProjectionThreadLinkedPullRequest"],
  [49, "ProjectionThreadsUnsettledAt"],
  [50, "JarvisWorkStartedCandidates"],
  [51, "JarvisFollowUpQueue"],
  [52, "JarvisProjectAliasCurrentState"],
  [53, "JarvisTaskDeskCurrentState"],
  [54, "JarvisPresentation"],
  [55, "JarvisFollowUpQueueIdentity"],
  [56, "JarvisTaskRefIdentity"],
  [57, "ProviderResponseFailureReasons"],
  [58, "JarvisPushRegistrations"],
  [59, "ClearAutomaticProjectModelDefaults"],
  [60, "ProjectionProjectsAutoPull"],
  [61, "RepairAutomaticSettlementTimestamps"],
  [62, "ProjectionProjectIcon"],
  [63, "ProjectionThreadBranchPullRequest"],
  [64, "ProjectionThreadsActiveOrderKey"],
  [65, "ProjectionThreadPullRequests"],
];

layer("MigrationRemap", (it) => {
  it.effect("registers every migration exactly once, in upgrade order", () =>
    Effect.gen(function* () {
      const ids = migrationManifest.map(([id]) => id as number);
      const names = migrationManifest.map(([, name]) => name as string);
      // Contiguous 1..65: no gaps, no duplicates, no renumbered slots.
      assert.deepEqual(
        ids,
        Array.from({ length: 65 }, (_, index) => index + 1),
      );
      assert.equal(new Set(names).size, names.length);
      for (const [id, name] of EXPECTED_MANIFEST) {
        assert.equal(names[id - 1], name, `migration ${id} must keep its shipped slot`);
      }
    }),
  );

  it.effect("upgrades a shipped 1-58 database by applying only 59-65", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const first = yield* runMigrations({ toMigrationInclusive: 58 });
      assert.equal(first.length, 58);

      const second = yield* runMigrations();
      assert.deepEqual(
        second.map(([id]) => Number(id)),
        [59, 60, 61, 62, 63, 64, 65],
      );

      // The shifted 47/48/49 rows keep the names databases recorded before
      // the rebase, so the migrator never double-applies their DDL.
      const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.equal(recorded.length, 65);
      assert.deepEqual(
        recorded.slice(46, 49).map((row) => [Number(row.migration_id), row.name]),
        [
          [47, "AuthSessionClientConnection"],
          [48, "ProjectionThreadLinkedPullRequest"],
          [49, "ProjectionThreadsUnsettledAt"],
        ],
      );
      assert.deepEqual(
        recorded.slice(58).map((row) => [Number(row.migration_id), row.name]),
        [
          [59, "ClearAutomaticProjectModelDefaults"],
          [60, "ProjectionProjectsAutoPull"],
          [61, "RepairAutomaticSettlementTimestamps"],
          [62, "ProjectionProjectIcon"],
          [63, "ProjectionThreadBranchPullRequest"],
          [64, "ProjectionThreadsActiveOrderKey"],
          [65, "ProjectionThreadPullRequests"],
        ],
      );

      // A third run is a no-op: nothing re-applies.
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );
});
