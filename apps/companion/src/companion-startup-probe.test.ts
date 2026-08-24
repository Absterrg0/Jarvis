// @effect-diagnostics nodeBuiltinImport:off - this opt-in CI receipt is deliberately
// written synchronously and atomically.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  COMPANION_STARTUP_PROBE_PHASE,
  COMPANION_STARTUP_PROBE_SCHEMA_VERSION,
  resolveCompanionStartupProbePath,
  writeCompanionStartupReceipt,
} from "./companion-startup-probe.ts";

describe("CompanionStartupProbe", () => {
  it("only enables the receipt when the startup-smoke environment path is present", () => {
    assert.equal(resolveCompanionStartupProbePath({ env: {} }), null);
    assert.equal(
      resolveCompanionStartupProbePath({
        env: { JARVIS_COMPANION_STARTUP_PROBE_FILE: " /tmp/jarvis-companion.json " },
      }),
      "/tmp/jarvis-companion.json",
    );
  });

  it("writes one exact structured receipt through an atomic rename", () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "jarvis-companion-startup-probe-"),
    );
    try {
      const path = NodePath.join(directory, "nested", "startup.json");
      const receipt = writeCompanionStartupReceipt(path, {
        version: "0.3.1256",
        platform: "linux",
      });
      assert.deepEqual(JSON.parse(NodeFS.readFileSync(path, "utf8")), {
        schemaVersion: COMPANION_STARTUP_PROBE_SCHEMA_VERSION,
        product: "Jarvis Companion",
        version: "0.3.1256",
        platform: "linux",
        phase: COMPANION_STARTUP_PROBE_PHASE,
      });
      assert.deepEqual(receipt, JSON.parse(NodeFS.readFileSync(path, "utf8")));
      assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(path)), ["startup.json"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
