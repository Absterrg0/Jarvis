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

layer("Database adoption", (it) => {
  it.effect("adopts an unmarked database whose history is unambiguously Circe's", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-adopt-"))),
      (baseDir) =>
        Effect.gen(function* () {
          // Seed a fully migrated Circe history in the shared in-memory
          // database so this test does not depend on another test's state.
          yield* runMigrations();
          const executed = yield* runMigrations({ baseDir });

          assert.deepEqual(executed, []);
          assert.isTrue(NodeFS.existsSync(NodePath.join(baseDir, CIRCE_OWNER_MARKER)));
        }),
      (baseDir) => Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
    ),
  );
});
