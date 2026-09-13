// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";

import {
  CIRCE_DESKTOP_PACKAGE_AUTHOR,
  CIRCE_DESKTOP_PACKAGE_DESCRIPTION,
} from "./build-desktop-artifact.ts";

it("keeps Circe-only desktop stage identity and installer artwork", () => {
  assert.equal(CIRCE_DESKTOP_PACKAGE_DESCRIPTION, "Circe desktop build");
  assert.equal(CIRCE_DESKTOP_PACKAGE_AUTHOR, "Abstergo");
  for (const name of ["dmg-background-latest.svg", "dmg-background-nightly.svg"]) {
    const artwork = NodeFS.readFileSync(
      new URL(`../apps/desktop/resources/dmg/${name}`, import.meta.url),
      "utf8",
    );
    assert.include(artwork, "Circe");
    assert.include(artwork, "Desktop");
    assert.include(artwork, "Drag Circe to Applications");
    assert.notMatch(artwork, /T3 CODE/iu);
  }
});
