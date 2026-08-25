// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { verifyArtifactBundle, verifyInstalledPayload } from "./verify-windows-setup.mjs";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function sliceWorkflowJob(workflow: string, jobName: string): string {
  const start = workflow.indexOf(`  ${jobName}:`);
  if (start < 0) return "";
  const nextJobOffset = workflow.slice(start + 1).search(/\n  [A-Za-z0-9_-]+:/u);
  const end = nextJobOffset < 0 ? workflow.length : start + 1 + nextJobOffset;
  return workflow.slice(start, end);
}

describe("standalone Windows setup verifier", () => {
  it("verifies release metadata and installed payload bytes without repository imports", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-verify-test-"));
    try {
      const artifactName = "Jarvis-Setup-1.2.3-win-x64.exe";
      const manifestName = `${artifactName}.manifest.json`;
      const provenanceName = `${artifactName}.provenance.json`;
      const artifactPath = NodePath.join(root, artifactName);
      const aliasPath = NodePath.join(root, "Jarvis-Setup.exe");
      const manifestPath = NodePath.join(root, manifestName);
      const checksumPath = NodePath.join(root, `${artifactName}.sha256`);
      const provenancePath = NodePath.join(root, provenanceName);
      const artifact = Buffer.from("installer");
      const artifactSha256 = NodeCrypto.createHash("sha256").update(artifact).digest("hex");
      const payload = Buffer.from("payload");
      const payloadSha256 = NodeCrypto.createHash("sha256").update(payload).digest("hex");
      const manifest = {
        format: 3,
        product: "Jarvis",
        version: "1.2.3",
        platform: "windows",
        arch: "x64",
        artifactName,
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        payloads: [
          {
            id: "desktop",
            modes: ["full", "controller"],
            files: [{ path: "payload.txt", bytes: payload.byteLength, sha256: payloadSha256 }],
          },
          { id: "runtime-win", modes: ["headless"], files: [] },
        ],
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      const manifestSha256 = NodeCrypto.createHash("sha256").update(manifestBytes).digest("hex");
      const provenance = {
        format: 1,
        product: "Jarvis",
        artifactName,
        artifactSha256,
        aliasName: "Jarvis-Setup.exe",
        manifestName,
        manifestSha256,
        provenanceName,
        sourceCommit: manifest.sourceCommit,
        version: manifest.version,
        arch: manifest.arch,
      };
      await NodeFSP.writeFile(artifactPath, artifact);
      await NodeFSP.writeFile(aliasPath, artifact);
      await NodeFSP.writeFile(manifestPath, manifestBytes);
      await NodeFSP.writeFile(checksumPath, `${artifactSha256}  ${artifactName}\n`);
      await NodeFSP.writeFile(provenancePath, `${JSON.stringify(provenance)}\n`);
      const installedRoot = NodePath.join(root, "installed", "desktop");
      await NodeFSP.mkdir(installedRoot, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(installedRoot, "payload.txt"), payload);

      await expect(
        verifyArtifactBundle({
          artifactPath,
          aliasPath,
          manifestPath,
          checksumPath,
          provenancePath,
        }),
      ).resolves.toMatchObject({ payloadIds: ["desktop", "runtime-win"] });
      const desktopPayload = manifest.payloads[0];
      if (!desktopPayload) throw new Error("Desktop payload fixture is missing.");
      await expect(verifyInstalledPayload(desktopPayload, installedRoot)).resolves.toBeUndefined();

      await NodeFSP.appendFile(artifactPath, "tampered");
      await expect(
        verifyArtifactBundle({
          artifactPath,
          aliasPath,
          manifestPath,
          checksumPath,
          provenancePath,
        }),
      ).rejects.toThrow(/SHA256 sidecar/u);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps clean acceptance source-free and gates publication", async () => {
    const workflow = await NodeFSP.readFile(
      NodePath.join(repoRoot, ".github/workflows/jarvis-setup-windows.yml"),
      "utf8",
    );
    const cleanJob = sliceWorkflowJob(workflow, "clean-install-test");
    expect(cleanJob).not.toBe("");
    expect(cleanJob).not.toContain("actions/checkout");
    expect(cleanJob).not.toContain("setup-vp");
    expect(workflow).toContain("needs: build-package");
    expect(workflow).not.toContain("publish-windows-release:");
    expect(workflow).not.toMatch(/gh release|softprops\/action-gh-release/u);

    const coordinator = await NodeFSP.readFile(
      NodePath.join(repoRoot, ".github/workflows/jarvis-release.yml"),
      "utf8",
    );
    expect(coordinator).toContain(
      "needs: [preflight, build_linux, build_windows, build_mac, build_headless, build_companion]",
    );
    expect(coordinator).toContain('cp "release-assets/$setup" release-assets/Jarvis-Setup.exe');
    expect(coordinator).toContain("build_windows");
    expect(coordinator).toContain("scripts/jarvis-release-transaction.ts release-assets");
  });

  it("sets up pnpm before staging the standalone runtime", async () => {
    const workflow = await NodeFSP.readFile(
      NodePath.join(repoRoot, ".github/workflows/jarvis-setup-windows.yml"),
      "utf8",
    );
    const pnpmSetupStart = workflow.indexOf("      - name: Setup pnpm");
    const resolveStart = workflow.indexOf("      - id: resolve_version", pnpmSetupStart);
    const stageStart = workflow.indexOf("      - name: Stage standalone Windows runtime");
    const stageEnd = workflow.indexOf("      - name: Build outer Jarvis Setup", stageStart);
    expect(pnpmSetupStart).toBeGreaterThanOrEqual(0);
    expect(resolveStart).toBeGreaterThan(pnpmSetupStart);
    expect(stageStart).toBeGreaterThanOrEqual(0);
    expect(stageEnd).toBeGreaterThan(stageStart);
    expect(pnpmSetupStart).toBeLessThan(stageStart);
    const pnpmSetup = workflow.slice(pnpmSetupStart, resolveStart);
    expect(pnpmSetup).toContain("uses: pnpm/setup@v1");
    expect(pnpmSetup).toContain("package-json-file: package.json");
    expect(pnpmSetup).toContain("install: false");
    const staticSetupStart = workflow.indexOf("      - name: Static setup contracts");
    const desktopBuildStart = workflow.indexOf("      - name: Build desktop payload directory");
    const voicePrepareStart = workflow.indexOf(
      "      - name: Prepare shared native voice resources for Windows Desktop",
    );
    const staticSetupEnd = voicePrepareStart;
    expect(staticSetupStart).toBeGreaterThanOrEqual(0);
    expect(staticSetupEnd).toBeGreaterThan(staticSetupStart);
    const staticSetup = workflow.slice(staticSetupStart, staticSetupEnd);
    expect(staticSetup).toContain("function Invoke-Test");
    expect(staticSetup).toContain("Invoke-Test @('scripts/stage-windows-runtime.test.ts')");
    expect(staticSetup).toContain("if ($LASTEXITCODE -ne 0)");
    expect(voicePrepareStart).toBeGreaterThanOrEqual(0);
    expect(desktopBuildStart).toBeGreaterThan(voicePrepareStart);
    expect(workflow).not.toContain("Compile setup smoke fixture");
    expect(workflow).toContain("'--voice-resources-dir', $env:JARVIS_VOICE_RESOURCES");
    const stage = workflow.slice(stageStart, stageEnd);
    expect(stage).toContain(
      "pnpm --config.inject-workspace-packages=true --config.node-linker=hoisted --config.package-import-method=copy --filter t3 deploy --prod $deploy",
    );
    expect(stage).not.toContain("--legacy");
    expect(stage).toContain(
      "node scripts/stage-windows-runtime.ts --source $deploy --target $runtime",
    );
    expect(stage).not.toContain("service-launcher.mjs");
    expect(stage).toContain('& "$runtime\\node\\node.exe" "$runtime\\dist\\bin.mjs" --help');
    expect(stage).toContain("Run the T3 Code server");
    expect(stage).toContain("[setup-ci] Runtime payload:");
    expect(stage).not.toContain("Copy-Item -Destination $runtime");
    expect(stage).not.toContain(".vite-plus");
  });

  it("prints bounded headless runtime diagnostics only after health timeout", async () => {
    const workflow = await NodeFSP.readFile(
      NodePath.join(repoRoot, ".github/workflows/jarvis-setup-windows.yml"),
      "utf8",
    );
    const cleanJob = sliceWorkflowJob(workflow, "clean-install-test");
    const healthFailure = cleanJob.indexOf("if ($null -eq $descriptor)");
    const diagnostics = cleanJob.slice(
      healthFailure,
      cleanJob.indexOf("throw 'Headless runtime", healthFailure),
    );
    expect(healthFailure).toBeGreaterThanOrEqual(0);
    expect(diagnostics).toContain("Get-ScheduledTaskInfo -TaskName 'Jarvis Headless Node'");
    expect(diagnostics).toContain("LastTaskResult");
    expect(diagnostics).toContain("LastRunTime");
    expect(diagnostics).toContain("NextRunTime");
    expect(diagnostics).toContain("$task.Actions");
    expect(diagnostics).toContain("$action.Execute");
    expect(diagnostics).toContain("$action.Arguments");
    expect(diagnostics).toContain("$action.WorkingDirectory");
    expect(diagnostics).toContain("Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\"");
    expect(diagnostics).toContain("$process.ProcessId");
    expect(diagnostics).toContain("$process.ExecutablePath");
    expect(diagnostics).toContain("$process.CommandLine");
    expect(diagnostics).toContain("Get-NetTCPConnection -LocalPort 3773");
    expect(diagnostics).toContain("$connection.OwningProcess");
    expect(diagnostics).toContain("$connection.State");
    expect(diagnostics).toContain("$connection.LocalAddress");
  });

  it("runs the packaged desktop probe through graceful quit and captures main-process failures", async () => {
    const workflow = await NodeFSP.readFile(
      NodePath.join(repoRoot, ".github/workflows/jarvis-setup-windows.yml"),
      "utf8",
    );
    const cleanJob = sliceWorkflowJob(workflow, "clean-install-test");
    const probeStart = cleanJob.indexOf("function Invoke-InstalledDesktopProbe");
    const probeEnd = cleanJob.indexOf("function Assert-JarvisRegistration", probeStart);
    const probe = cleanJob.slice(probeStart, probeEnd);
    expect(probeStart).toBeGreaterThanOrEqual(0);
    expect(probeEnd).toBeGreaterThan(probeStart);
    expect(probe).toContain("T3CODE_HOME = (Join-Path $probeRoot 't3-home')");
    expect(probe).toContain("JARVIS_STARTUP_PROBE_QUIT = '1'");
    expect(probe).toContain("-RedirectStandardOutput $stdoutPath");
    expect(probe).toContain("-RedirectStandardError $stderrPath");
    expect(probe).toContain("if (-not $desktop.WaitForExit(30000))");
    expect(probe).toContain("$desktop.ExitCode -ne 0");
    expect(probe).toContain("object has been destroyed");
    expect(probe).toContain("uncaught");
    expect(probe).toContain("Bounded $Label main-process output");
    const gracefulWait = probe.indexOf("if (-not $desktop.WaitForExit(30000))");
    const forceCleanup = probe.indexOf("Stop-Process -Id $desktop.Id -Force");
    expect(forceCleanup).toBeGreaterThan(gracefulWait);
  });

  it("keeps the native headless lifecycle gate exact and bounded", async () => {
    const workflow = await NodeFSP.readFile(
      NodePath.join(repoRoot, ".github/workflows/jarvis-setup-windows.yml"),
      "utf8",
    );
    const cleanJob = sliceWorkflowJob(workflow, "clean-install-test");
    expect(workflow).toContain("renderWindowsNodeStopPs1");
    expect(workflow).toContain("renderWindowsNodeSupervisorMjs");
    expect(cleanJob).toContain('$runtimeServerCommand = "$root\\runtime-win\\dist\\bin.mjs"');
    expect(cleanJob).toContain(
      '$runtimeSupervisorCommand = "$root\\runtime-win\\jarvis-node-supervisor.mjs"',
    );
    expect(cleanJob).toContain("[System.StringComparison]::OrdinalIgnoreCase");
    expect(cleanJob).toContain("Stop-Process -Id $firstHeadlessServerPid -Force");
    expect(cleanJob).toContain("$candidateServers[0].ProcessId -ne $firstHeadlessServerPid");
    expect(cleanJob).toContain(
      "Stop-Process -Id $firstSupervisorPid -Force -ErrorAction SilentlyContinue",
    );
    expect(cleanJob).toContain("$orphanCleanupDeadline = (Get-Date).AddSeconds(15)");
    expect(cleanJob).toContain("$orphanServers.Count -ne 0");
    expect(cleanJob).toContain("Supervisor crash cleanup left the old exact server child running.");
    expect(cleanJob).toContain("$candidateSupervisors[0].ProcessId -ne $firstSupervisorPid");
    expect(cleanJob).toContain(
      "$candidateServersAfterSupervisor[0].ProcessId -ne $restartedServerPid",
    );
    expect(cleanJob).toContain(
      "CMD did not restart a new supervisor with a new healthy exact server child.",
    );
    expect(cleanJob).toContain("Headless to Controller reverse upgrade starting.");
    expect(cleanJob).toContain("Controller to Headless upgrade starting.");
    expect(cleanJob).toContain("Second headless payload bytes do not match the manifest.");
    expect(cleanJob).toContain(
      "Headless supervisor did not restart a new healthy exact server child.",
    );
    expect(cleanJob).toContain(
      "Headless to Controller upgrade left the task, endpoint, or bundled runtime process running.",
    );
    expect(cleanJob).toContain("$controllerShutdownDeadline = (Get-Date).AddSeconds(30)");
    expect(cleanJob).toContain("Controller to Headless upgrade");
    const restartStart = cleanJob.indexOf("Restarting the exact bundled headless server child");
    const supervisorRestartStart = cleanJob.indexOf("Restarting the exact bundled supervisor PID");
    const reverseControllerStart = cleanJob.indexOf(
      "Headless to Controller reverse upgrade starting.",
    );
    const secondHeadlessStart = cleanJob.indexOf("Controller to Headless upgrade starting.");
    const uninstallStart = cleanJob.indexOf("Write-Host '[setup-ci] Uninstall starting.'");
    expect(restartStart).toBeGreaterThan(-1);
    expect(restartStart).toBeLessThan(reverseControllerStart);
    expect(supervisorRestartStart).toBeGreaterThan(restartStart);
    expect(supervisorRestartStart).toBeLessThan(reverseControllerStart);
    expect(reverseControllerStart).toBeLessThan(secondHeadlessStart);
    expect(secondHeadlessStart).toBeLessThan(uninstallStart);
  });

  it("uploads every setup sidecar from the exported output directory", async () => {
    const workflow = await NodeFSP.readFile(
      NodePath.join(repoRoot, ".github/workflows/jarvis-setup-windows.yml"),
      "utf8",
    );
    const uploadStart = workflow.indexOf("      - name: Upload setup artifacts");
    const uploadEnd = workflow.indexOf("  clean-install-test:", uploadStart);
    expect(uploadStart).toBeGreaterThanOrEqual(0);
    expect(uploadEnd).toBeGreaterThan(uploadStart);
    const upload = workflow.slice(uploadStart, uploadEnd);
    expect(upload).toContain("${{ env.JARVIS_SETUP_EXE }}");
    expect(upload).toContain("compression-level: 0");
    expect(upload).not.toContain("${{ env.JARVIS_SETUP_OUTPUT_DIR }}/Jarvis-Setup.exe");
    expect(upload).toContain("${{ env.JARVIS_SETUP_OUTPUT_DIR }}/*.manifest.json");
    expect(upload).toContain("${{ env.JARVIS_SETUP_OUTPUT_DIR }}/*.provenance.json");
    expect(upload).toContain("${{ env.JARVIS_SETUP_OUTPUT_DIR }}/*.sha256");
    expect(upload).toContain("${{ env.JARVIS_SETUP_OUTPUT_DIR }}/verify-windows-setup.mjs");
    expect(upload).not.toContain("${{ env.RUNNER_TEMP }}");
  });

  it("hashes the final UI payload after controller upgrade and reconstructs the release alias", async () => {
    const workflow = await NodeFSP.readFile(
      NodePath.join(repoRoot, ".github/workflows/jarvis-setup-windows.yml"),
      "utf8",
    );
    const cleanJob = sliceWorkflowJob(workflow, "clean-install-test");
    expect(cleanJob).not.toBe("");
    expect(cleanJob).toContain(
      "Copy-Item -LiteralPath $artifactPath -Destination $aliasPath -Force",
    );
    expect(cleanJob).toContain("[setup-ci] Full install starting");
    expect(cleanJob).toContain("[setup-ci] Controller upgrade starting");
    expect(cleanJob).toContain("[setup-ci] Controller payload verification starting");
    expect(cleanJob).toContain("[setup-ci] Headless upgrade starting");
    expect(cleanJob).toContain("[setup-ci] Headless payload verification starting");
    expect(cleanJob).toContain("[setup-ci] Uninstall starting");
    expect(cleanJob).toContain("WaitForExit(600000)");
    expect(cleanJob).toContain("Stop-Process -Id $process.Id");
    expect(cleanJob).toContain("function Wait-ForInstallRootRemoval");
    expect(cleanJob).toContain("[System.IO.Path]::GetFullPath($InstallRoot)");
    expect(cleanJob).toContain("Test-Path -LiteralPath $exactRoot");
    expect(cleanJob).toContain("Start-Sleep -Milliseconds 250");
    expect(cleanJob).toContain("Get-ChildItem -LiteralPath $exactRoot -Force");
    expect(cleanJob).toContain("Select-Object -First 25");
    expect(cleanJob).toContain("diagnostics capped at the first 25");
    expect(cleanJob).toContain("Remaining exact-root entry:");
    expect(cleanJob).not.toContain(
      "if (Test-Path $root) { throw 'Full uninstall left the install root behind.' }",
    );
    expect(cleanJob).toContain("main-window-revealed");
    expect(cleanJob).toContain("$receipt.version -ne $env:JARVIS_SETUP_VERSION");
    expect(cleanJob).toContain("Assert-JarvisRegistration -Installed $true -InstallRoot $root");
    expect(cleanJob).toContain("Assert-JarvisRegistration -Installed $false -InstallRoot $root");
    expect(cleanJob).toContain("$displayIcon = $displayIcon.Trim().Trim('\"')");
    expect(cleanJob).toContain(
      "$expectedDisplayIcon = [System.IO.Path]::GetFullPath((Join-Path -Path $InstallRoot -ChildPath 'desktop\\Jarvis.exe'))",
    );
    expect(cleanJob).toContain(
      "[System.String]::Equals($displayIcon, $expectedDisplayIcon, [System.StringComparison]::OrdinalIgnoreCase)",
    );
    expect(cleanJob).not.toContain("-notlike '*\\\\desktop\\\\Jarvis.exe'");
    expect(cleanJob).not.toContain("JARVIS_COMPANION_PAYLOAD");
    for (const label of [
      "Full install",
      "Full uninstall",
      "Clean Controller install",
      "Controller upgrade",
      "Headless upgrade",
      "Headless to Controller upgrade",
      "Controller to Headless upgrade",
      "Uninstall",
    ]) {
      expect(
        cleanJob.match(new RegExp(`Invoke-SetupLifecycleProcess -Label '${label}'`, "g")) ?? [],
      ).toHaveLength(1);
    }
    expect(
      cleanJob.match(/node \$verifierPath installed \$manifestPath \$root desktop/g) ?? [],
    ).toHaveLength(4);
    expect(
      cleanJob.match(/node \$verifierPath installed \$manifestPath \$root runtime-win/g) ?? [],
    ).toHaveLength(2);
    const fullInstall = cleanJob.indexOf("Invoke-SetupLifecycleProcess -Label 'Full install'");
    const fullVerification = cleanJob.indexOf(
      "node $verifierPath installed $manifestPath $root desktop",
      fullInstall,
    );
    const fullProbe = cleanJob.indexOf(
      "Invoke-InstalledDesktopProbe -Label 'Full Desktop'",
      fullInstall,
    );
    expect(fullInstall).toBeGreaterThanOrEqual(0);
    expect(fullVerification).toBeGreaterThan(fullInstall);
    expect(fullVerification).toBeLessThan(fullProbe);
    const fullUninstall = cleanJob.indexOf("Invoke-SetupLifecycleProcess -Label 'Full uninstall'");
    const fullRootWait = cleanJob.indexOf(
      "Wait-ForInstallRootRemoval -Label 'Full uninstall' -InstallRoot $root",
    );
    const fullUninstallRegistration = cleanJob.indexOf(
      "Assert-JarvisRegistration -Installed $false -InstallRoot $root",
      fullUninstall,
    );
    const finalUninstall = cleanJob.indexOf("Invoke-SetupLifecycleProcess -Label 'Uninstall'");
    const finalRootWait = cleanJob.indexOf(
      "Wait-ForInstallRootRemoval -Label 'Uninstall' -InstallRoot $root",
      finalUninstall,
    );
    const finalUninstallRegistration = cleanJob.indexOf(
      "Assert-JarvisRegistration -Installed $false -InstallRoot $root",
      finalUninstall,
    );
    expect(fullUninstall).toBeGreaterThanOrEqual(0);
    expect(fullRootWait).toBeGreaterThan(fullUninstall);
    expect(fullUninstallRegistration).toBeGreaterThan(fullRootWait);
    expect(finalUninstall).toBeGreaterThan(fullUninstall);
    expect(finalRootWait).toBeGreaterThan(finalUninstall);
    expect(finalUninstallRegistration).toBeGreaterThan(finalRootWait);
    expect(cleanJob.match(/Wait-ForInstallRootRemoval -Label '/g) ?? []).toHaveLength(2);
    const controllerUpgrade = cleanJob.indexOf(
      "Invoke-SetupLifecycleProcess -Label 'Controller upgrade'",
    );
    const uiVerification = cleanJob.indexOf(
      "node $verifierPath installed $manifestPath $root desktop",
      controllerUpgrade,
    );
    expect(controllerUpgrade).toBeGreaterThanOrEqual(0);
    expect(uiVerification).toBeGreaterThan(controllerUpgrade);
    expect(workflow).not.toContain("publish-windows-release:");
    expect(workflow).not.toMatch(/gh release|softprops\/action-gh-release/u);
    const coordinator = await NodeFSP.readFile(
      NodePath.join(repoRoot, ".github/workflows/jarvis-release.yml"),
      "utf8",
    );
    const aliasIndex = coordinator.indexOf(
      'cp "release-assets/$setup" release-assets/Jarvis-Setup.exe',
    );
    const promoteNeedsIndex = coordinator.indexOf(
      "needs: [preflight, build_linux, build_windows, build_mac, build_headless, build_companion]",
    );
    const uploadIndex = coordinator.indexOf("scripts/jarvis-release-transaction.ts release-assets");
    expect(aliasIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(aliasIndex);
    expect(uploadIndex).toBeGreaterThan(promoteNeedsIndex);
  });
});
