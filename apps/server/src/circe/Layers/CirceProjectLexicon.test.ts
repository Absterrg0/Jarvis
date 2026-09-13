// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { CirceProjectLexicon } from "../Services/CirceProjectLexicon.ts";
import { CirceProjectLexiconLive } from "./CirceProjectLexicon.ts";

it.effect("persists, deduplicates, and forgets confirmed pronunciations across restart", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-circe-lexicon-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const layer = CirceProjectLexiconLive.pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"))),
      Layer.provideMerge(NodeServices.layer),
    );
    const projectId = ProjectId.make("project-rivvl");

    yield* Effect.gen(function* () {
      const lexicon = yield* CirceProjectLexicon;
      yield* lexicon.learn({ projectId, alias: "Ripple", kind: "confirmed-pronunciation" });
      yield* lexicon.learn({ projectId, alias: " ripple ", kind: "confirmed-pronunciation" });
    }).pipe(Effect.provide(layer));

    yield* Effect.gen(function* () {
      const lexicon = yield* CirceProjectLexicon;
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        (yield* lexicon.list()).map(({ alias, kind }) => ({ alias, kind })),
        [{ alias: "ripple", kind: "confirmed-pronunciation" }],
      );
      assert.deepEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'circe_project_alias_events'
        `,
        [],
      );
      assert.isTrue(yield* lexicon.forget({ projectId, alias: "RIPPLE" }));
      assert.isFalse(yield* lexicon.forget({ projectId, alias: "RIPPLE" }));
      assert.deepEqual(yield* lexicon.list(), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps user aliases authoritative and bounds the current state", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-circe-lexicon-bound-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const layer = CirceProjectLexiconLive.pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"))),
      Layer.provideMerge(NodeServices.layer),
    );
    const projectId = ProjectId.make("project-rivvl");

    yield* Effect.gen(function* () {
      const lexicon = yield* CirceProjectLexicon;
      yield* lexicon.learn({ projectId, alias: "Preferred", kind: "user-defined" });
      yield* lexicon.learn({ projectId, alias: "preferred", kind: "confirmed-pronunciation" });
      for (let index = 0; index < 19; index += 1) {
        yield* lexicon.learn({
          projectId,
          alias: `spoken-${index}`,
          kind: "confirmed-pronunciation",
        });
      }

      const aliases = yield* lexicon.list();
      assert.equal(aliases.length, 20);
      assert.equal(aliases.find(({ alias }) => alias === "preferred")?.kind, "user-defined");
      yield* lexicon.learn({ projectId, alias: "overflow", kind: "confirmed-pronunciation" });
      assert.equal((yield* lexicon.list()).length, 20);
      assert.isFalse(yield* lexicon.forget({ projectId, alias: "missing" }));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("prunes same-timestamp aliases deterministically by insertion order", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-circe-lexicon-ties-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const layer = CirceProjectLexiconLive.pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"))),
      Layer.provideMerge(NodeServices.layer),
    );
    const projectId = ProjectId.make("project-ties");

    yield* Effect.gen(function* () {
      const lexicon = yield* CirceProjectLexicon;
      const sql = yield* SqlClient.SqlClient;
      // Twenty aliases sharing one timestamp: without a stable tiebreaker the
      // prune keeps an arbitrary subset instead of the newest insertions.
      // The effect test clock is frozen, so read the same instant learn uses.
      const sharedTimestamp = DateTime.formatIso(yield* DateTime.now);
      for (let index = 0; index < 20; index += 1) {
        const name = `tie-${String(index).padStart(2, "0")}`;
        yield* sql`
          INSERT INTO circe_project_aliases(project_id, normalized_alias, alias, kind, updated_at)
          VALUES (${projectId}, ${name}, ${name}, 'confirmed-pronunciation', ${sharedTimestamp})
        `;
      }
      yield* lexicon.learn({ projectId, alias: "newest", kind: "confirmed-pronunciation" });

      const names = (yield* lexicon.list()).map(({ alias }) => alias);
      assert.equal(names.length, 20);
      assert.isTrue(names.includes("newest"));
      // The oldest same-timestamp insertion loses deterministically.
      assert.isFalse(names.includes("tie-00"));
      assert.isTrue(names.includes("tie-19"));
    }).pipe(Effect.provide(layer));
  }),
);
