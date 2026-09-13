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

  it("launches the copied app through LaunchServices and quits only its exact bundle", () => {
    assert.include(source, 'const launchCommand = "/usr/bin/open"');
    assert.include(source, 'const launchArgs = ["-n", "-W", appBundle, "--args"]');
    assert.include(source, 'const circeBundleId = "com.abstergo.circe"');
    assert.include(source, '"/usr/bin/osascript"');
    assert.include(source, "tell application id");
    assert.notInclude(source, "Contents/MacOS");
    assert.notInclude(source, "pkill");
    assert.notInclude(source, "pgrep");
  });

  it("bounds and prints the app log for every receipt failure", () => {
    assert.include(source, "MAX_LOG_BYTES = 32 * 1024");
    assert.include(source, "contents.subarray(contents.length - MAX_LOG_BYTES)");
    assert.include(source, "if (!startupSucceeded)");
    assert.include(source, "printBoundedLog();");
  });

  it("tolerates torn receipt writes but compares fields independent of key order", () => {
    assert.include(source, "let the startup timeout decide instead of failing on a torn read");
    assert.include(source, "value.schemaVersion !== expectedReceipt.schemaVersion");
    assert.include(source, "value.phase !== expectedReceipt.phase");
    assert.notInclude(source, "JSON.stringify(value) !== JSON.stringify(expectedReceipt)");
    assert.include(source, "Unexpected startup receipt");
  });
});
