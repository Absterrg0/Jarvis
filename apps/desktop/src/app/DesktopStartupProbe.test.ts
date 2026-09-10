// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  STARTUP_PROBE_PHASE,
  STARTUP_PROBE_SCHEMA_VERSION,
  resolveStartupProbeQuit,
  resolveStartupProbePath,
  writeStartupReceipt,
} from "./DesktopStartupProbe.ts";

describe("DesktopStartupProbe", () => {
  it("accepts the CI environment path and leaves normal launches disabled", () => {
    assert.equal(resolveStartupProbePath({ env: {}, argv: [] }), null);
    assert.equal(
      resolveStartupProbePath({
        env: { JARVIS_STARTUP_PROBE_FILE: " /tmp/jarvis-startup.json " },
        argv: ["--jarvis-startup-probe=/tmp/ignored.json"],
      }),
      "/tmp/jarvis-startup.json",
    );
  });

  it("accepts an explicit unambiguous command-line probe path", () => {
    assert.equal(
      resolveStartupProbePath({ argv: ["--jarvis-startup-probe=/tmp/jarvis-startup.json"] }),
      "/tmp/jarvis-startup.json",
    );
    assert.equal(
      resolveStartupProbePath({
        commandLine: {
          hasSwitch: (name) => name === "jarvis-startup-probe",
          getSwitchValue: () => "/tmp/from-electron-command-line.json",
        },
      }),
      "/tmp/from-electron-command-line.json",
    );
  });

  it("requests graceful quit only for an explicit probe flag", () => {
    assert.isFalse(resolveStartupProbeQuit({ env: {} }));
    assert.isFalse(resolveStartupProbeQuit({ env: { JARVIS_STARTUP_PROBE_QUIT: "0" } }));
    assert.isTrue(resolveStartupProbeQuit({ env: { JARVIS_STARTUP_PROBE_QUIT: "1" } }));
    assert.isTrue(resolveStartupProbeQuit({ env: { JARVIS_STARTUP_PROBE_QUIT: "true" } }));
  });

  it("writes one structured receipt through an atomic rename", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jarvis-startup-probe-"));
    try {
      const path = NodePath.join(directory, "nested", "startup.json");
      const receipt = writeStartupReceipt(path, { version: "0.0.38", platform: "linux" });
      assert.deepEqual(JSON.parse(NodeFS.readFileSync(path, "utf8")), {
        schemaVersion: STARTUP_PROBE_SCHEMA_VERSION,
        product: "Jarvis",
        version: "0.0.38",
        platform: "linux",
        phase: STARTUP_PROBE_PHASE,
      });
      assert.deepEqual(receipt, JSON.parse(NodeFS.readFileSync(path, "utf8")));
      assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(path)), ["startup.json"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
