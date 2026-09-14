// @effect-diagnostics nodeBuiltinImport:off - ownership-marker tests create and remove a real temp directory.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const CIRCE_OWNER_MARKER = "circe-product.json";

const makeTempBaseDir = Effect.sync(() =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-owner-")),
);

const removeDir = (baseDir: string) =>
  Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }));

layer("Database ownership", (it) => {
  it.effect("claims a fresh database directory and migrates it", () =>
    Effect.acquireUseRelease(
      makeTempBaseDir,
      (baseDir) =>
        Effect.gen(function* () {
          const executed = yield* runMigrations({ baseDir });

          assert.isAtLeast(executed.length, 65);
          assert.isTrue(NodeFS.existsSync(NodePath.join(baseDir, CIRCE_OWNER_MARKER)));
        }),
      removeDir,
    ),
  );

  it.effect("adopts an unmarked database whose history is unambiguously Circe's", () =>
    Effect.acquireUseRelease(
      makeTempBaseDir,
      (baseDir) =>
        Effect.gen(function* () {
          // The first test already applied every migration to this shared
          // in-memory database, so the history is Circe's but the new directory
          // has no marker yet.
          const executed = yield* runMigrations({ baseDir });

          assert.deepEqual(executed, []);
          assert.isTrue(NodeFS.existsSync(NodePath.join(baseDir, CIRCE_OWNER_MARKER)));
        }),
      removeDir,
    ),
  );
});
