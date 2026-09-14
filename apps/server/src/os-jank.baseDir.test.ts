// @effect-diagnostics nodeBuiltinImport:off - address the OS home directory by path in a test.
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Schema from "effect/Schema";

import { ForeignBaseDirectoryError, resolveBaseDir } from "./os-jank.ts";

const isForeignBaseDirectoryError = Schema.is(ForeignBaseDirectoryError);

it.layer(NodeServices.layer)("resolveBaseDir", (it) => {
  it.effect("defaults to ~/.circe, never the separate T3 Code home", () =>
    Effect.gen(function* () {
      const baseDir = yield* resolveBaseDir(undefined);

      assert.isTrue(baseDir.startsWith(NodeOS.homedir()));
      assert.isTrue(baseDir.endsWith(".circe"));
      assert.isFalse(baseDir.endsWith(".t3"));
    }),
  );

  it.effect("refuses another product's home directory", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(resolveBaseDir(NodePath.join(NodeOS.homedir(), ".t3")));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        const die = exit.cause.reasons.find(Cause.isDieReason);
        assert.isTrue(isForeignBaseDirectoryError(die?.defect));
      }
    }),
  );
});
