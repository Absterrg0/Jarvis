// @effect-diagnostics nodeBuiltinImport:off - this test inspects the native Windows smoke contract.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

describe("packaged Windows desktop lifecycle smoke", () => {
  it("launches the produced win-unpacked executable and requires graceful shutdown", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/jarvis-setup-windows.yml"),
      "utf8",
    );
    const smokeStart = workflow.indexOf("- name: Smoke packaged Windows desktop lifecycle");
    const smokeEnd = workflow.indexOf("- name: Stage standalone Windows runtime", smokeStart);
    const smoke = workflow.slice(smokeStart, smokeEnd);
    expect(smokeStart).toBeGreaterThanOrEqual(0);
    expect(smokeEnd).toBeGreaterThan(smokeStart);
    expect(smoke).toContain("scripts/windows-desktop-startup-smoke.ps1");
    expect(smoke).toContain("$env:JARVIS_DESKTOP_PAYLOAD 'Jarvis.exe'");
    expect(smoke).toContain("-Version $env:JARVIS_SETUP_VERSION");
  });

  it("captures bounded process output and rejects destroyed-window failures", () => {
    const script = NodeFS.readFileSync(
      NodePath.join(repoRoot, "scripts/windows-desktop-startup-smoke.ps1"),
      "utf8",
    );
    expect(script).toContain("JARVIS_STARTUP_PROBE_QUIT = '1'");
    expect(script).toContain("-RedirectStandardOutput $stdoutPath");
    expect(script).toContain("-RedirectStandardError $stderrPath");
    expect(script).toContain("WaitForExit(30000)");
    expect(script).toContain("object has been destroyed");
    expect(script).toContain("uncaught");
    expect(script).toContain("32768");
    expect(script).toContain("Stop-Process -Id $desktop.Id -Force");
  });
});
