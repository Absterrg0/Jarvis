// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const source = NodeFS.readFileSync(
  new URL("./mac-desktop-startup-smoke.mjs", import.meta.url),
  "utf8",
);

describe("macOS desktop startup smoke helper", () => {
  it("fails closed on a native architecture mismatch", () => {
    assert.include(source, "native architecture mismatch");
    assert.notInclude(source, "Rosetta");
    assert.notInclude(source, 'execFileSync("arch"');
  });

  it("bounds and prints the app log for every receipt failure", () => {
    assert.include(source, "MAX_LOG_BYTES = 32 * 1024");
    assert.include(source, "contents.subarray(contents.length - MAX_LOG_BYTES)");
    assert.include(source, "if (!startupSucceeded)");
    assert.include(source, "printBoundedLog();");
  });
});
