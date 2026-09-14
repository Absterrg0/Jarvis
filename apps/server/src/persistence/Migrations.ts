/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
// IDs 41-58 shipped on the Circe line and are never renumbered: 41-46 are the
// original Circe migrations, 47-49 carry the upstream 041/042/043 content that
// the fork absorbed under new IDs, and 50-58 are later Circe migrations.
// Upstream migrations that landed after the fork point (upstream 044-050) are
// re-registered above 58 so they apply exactly once, after the shipped IDs.
import Migration0041 from "./Migrations/041_CirceTaskDesks.ts";
import Migration0042 from "./Migrations/042_CirceTaskDeskAttention.ts";
import Migration0043 from "./Migrations/043_CirceTaskDeskClarification.ts";
import Migration0044 from "./Migrations/044_CirceProjectClarification.ts";
import Migration0045 from "./Migrations/045_CirceProjectAliases.ts";
import Migration0046 from "./Migrations/046_CirceReportOutbox.ts";
import Migration0047 from "./Migrations/047_AuthSessionClientConnection.ts";
import Migration0048 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0049 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0050 from "./Migrations/050_CirceWorkStartedCandidates.ts";
import Migration0051 from "./Migrations/051_CirceFollowUpQueue.ts";
import Migration0052 from "./Migrations/052_CirceProjectAliasCurrentState.ts";
import Migration0053 from "./Migrations/053_CirceTaskDeskCurrentState.ts";
import Migration0054 from "./Migrations/054_CircePresentation.ts";
import Migration0055 from "./Migrations/055_CirceFollowUpQueueIdentity.ts";
import Migration0056 from "./Migrations/056_CirceTaskRefIdentity.ts";
import Migration0057 from "./Migrations/057_ProviderResponseFailureReasons.ts";
import Migration0058 from "./Migrations/058_CircePushRegistrations.ts";
import Migration0059 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0060 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0061 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0062 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0063 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0064 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0065 from "./Migrations/050_ProjectionThreadPullRequests.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "CirceTaskDesks", Migration0041],
  [42, "CirceTaskDeskAttention", Migration0042],
  [43, "CirceTaskDeskClarification", Migration0043],
  [44, "CirceProjectClarification", Migration0044],
  [45, "CirceProjectAliases", Migration0045],
  [46, "CirceReportOutbox", Migration0046],
  [47, "AuthSessionClientConnection", Migration0047],
  [48, "ProjectionThreadLinkedPullRequest", Migration0048],
  [49, "ProjectionThreadsUnsettledAt", Migration0049],
  [50, "CirceWorkStartedCandidates", Migration0050],
  [51, "CirceFollowUpQueue", Migration0051],
  [52, "CirceProjectAliasCurrentState", Migration0052],
  [53, "CirceTaskDeskCurrentState", Migration0053],
  [54, "CircePresentation", Migration0054],
  [55, "CirceFollowUpQueueIdentity", Migration0055],
  [56, "CirceTaskRefIdentity", Migration0056],
  [57, "ProviderResponseFailureReasons", Migration0057],
  [58, "CircePushRegistrations", Migration0058],
  [59, "ClearAutomaticProjectModelDefaults", Migration0059],
  [60, "ProjectionProjectsAutoPull", Migration0060],
  [61, "RepairAutomaticSettlementTimestamps", Migration0061],
  [62, "ProjectionProjectIcon", Migration0062],
  [63, "ProjectionThreadBranchPullRequest", Migration0063],
  [64, "ProjectionThreadsActiveOrderKey", Migration0064],
  [65, "ProjectionThreadPullRequests", Migration0065],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

/**
 * A database whose recorded history disagrees with the shipped manifest belongs
 * to another product line (upstream T3 Code, or the pre-rebrand Jarvis build).
 * Running Circe migrations against it would collide on renumbered slots, so the
 * runner refuses before applying anything.
 */
export class ForeignDatabaseError extends Schema.TaggedError<ForeignDatabaseError>()(
  "ForeignDatabaseError",
  {
    migrationId: Schema.Number,
    recordedName: Schema.String,
    expectedName: Schema.String,
  },
) {
  override get message(): string {
    return [
      "Refusing to migrate a database that belongs to a different product.",
      `Migration ${this.migrationId} is recorded as "${this.recordedName}" but Circe expects "${this.expectedName}".`,
      "Circe stores its data in a .circe directory; do not point --base-dir or T3CODE_HOME at a T3 Code or Jarvis data directory.",
    ].join(" ");
  }
}

const assertCirceDatabase = Effect.fn("Migrations.assertCirceDatabase")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const trackingTable = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (trackingTable.length === 0) {
    return;
  }
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const expectedById = new Map<number, string>(migrationManifest.map(([id, name]) => [id, name]));
  for (const row of recorded) {
    const expected = expectedById.get(Number(row.migration_id));
    if (expected !== undefined && expected !== row.name) {
      return yield* Effect.die(
        new ForeignDatabaseError({
          migrationId: Number(row.migration_id),
          recordedName: row.name,
          expectedName: expected,
        }),
      );
    }
  }
});

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  yield* assertCirceDatabase();
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
