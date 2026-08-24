// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";

import {
  JARVIS_DESKTOP_PACKAGE_AUTHOR,
  JARVIS_DESKTOP_PACKAGE_DESCRIPTION,
} from "./build-desktop-artifact.ts";

it("keeps Jarvis-only desktop stage identity and installer artwork", () => {
  assert.equal(JARVIS_DESKTOP_PACKAGE_DESCRIPTION, "Jarvis desktop build");
  assert.equal(JARVIS_DESKTOP_PACKAGE_AUTHOR, "Abstergo");
  for (const name of ["dmg-background-latest.svg", "dmg-background-nightly.svg"]) {
    const artwork = NodeFS.readFileSync(
      new URL(`../apps/desktop/resources/dmg/${name}`, import.meta.url),
      "utf8",
    );
    assert.include(artwork, "JARVIS");
    assert.include(artwork, "Desktop");
    assert.include(artwork, "Drag Jarvis to Applications");
    assert.notMatch(artwork, /T3 CODE/iu);
  }
});
