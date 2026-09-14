import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { resolveBaseDir } from "./os-jank.ts";

it.layer(NodeServices.layer)("resolveBaseDir", (it) => {
  it.effect("defaults to ~/.circe, never the separate T3 Code home", () =>
    Effect.gen(function* () {
      const baseDir = yield* resolveBaseDir(undefined);

      assert.isTrue(baseDir.startsWith(NodeOS.homedir()));
      assert.isTrue(baseDir.endsWith(".circe"));
      assert.isFalse(baseDir.endsWith(".t3"));
    }),
  );
});
