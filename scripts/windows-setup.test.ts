// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "vite-plus/test";

import {
  createWindowsSetupProvenance,
  createWindowsSetupManifest,
  renderNodePresetJson,
  renderWindowsNodeLauncherCmd,
  renderWindowsNodeStopPs1,
  renderWindowsNodeSupervisorMjs,
  renderWindowsOwnedProcessStopPs1,
  renderWindowsSetupNsi,
  renderWindowsTaskCreateCommand,
  renderWindowsTaskXml,
  windowsSetupAliasName,
  windowsSetupArtifactName,
  windowsSetupManifestName,
  windowsSetupProvenanceName,
} from "./windows-setup.ts";

describe("Windows setup contracts", () => {
  it("creates deterministic payload hashes and exact release names", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-setup-test-"));
    const dirs = {
      desktop: NodePath.join(root, "desktop"),
      runtimeWin: NodePath.join(root, "runtime-win"),
    };
    await Promise.all(Object.values(dirs).map((dir) => NodeFSP.mkdir(dir, { recursive: true })));
    await NodeFSP.writeFile(NodePath.join(dirs.desktop, "Jarvis.exe"), "desktop");
    await NodeFSP.mkdir(NodePath.join(dirs.runtimeWin, "node"));
    await NodeFSP.writeFile(NodePath.join(dirs.runtimeWin, "node", "node.exe"), "runtime");

    const manifest = await createWindowsSetupManifest({
      version: "1.2.3",
      arch: "x64",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      payloadDirectories: dirs,
    });
    expect(manifest.artifactName).toBe("Jarvis-Setup-1.2.3-win-x64.exe");
    expect(windowsSetupAliasName()).toBe("Jarvis-Setup.exe");
    expect(manifest.payloads.map(({ id }) => id)).toEqual(["desktop", "runtime-win"]);
    expect(manifest.payloads[0]?.modes).toEqual(["full", "controller"]);
    expect(manifest.payloads[0]?.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.payloads[1]?.modes).toEqual(["headless"]);
    expect(manifest.format).toBe(3);
    expect(manifest.sourceCommit).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("creates provenance bound to the artifact, manifest, version, and source commit", () => {
    const provenance = createWindowsSetupProvenance({
      artifactName: windowsSetupArtifactName("1.2.3", "x64"),
      artifactSha256: "a".repeat(64),
      aliasName: "Jarvis-Setup.exe",
      manifestName: windowsSetupManifestName("1.2.3", "x64"),
      manifestSha256: "b".repeat(64),
      provenanceName: windowsSetupProvenanceName("1.2.3", "x64"),
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      version: "1.2.3",
      arch: "x64",
    });
    expect(provenance).toMatchObject({
      artifactName: "Jarvis-Setup-1.2.3-win-x64.exe",
      manifestName: "Jarvis-Setup-1.2.3-win-x64.exe.manifest.json",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(() =>
      createWindowsSetupProvenance({
        artifactName: provenance.artifactName,
        artifactSha256: "not-a-hash",
        aliasName: provenance.aliasName,
        manifestName: provenance.manifestName,
        manifestSha256: provenance.manifestSha256,
        provenanceName: provenance.provenanceName,
        sourceCommit: provenance.sourceCommit,
        version: provenance.version,
        arch: provenance.arch,
      }),
    ).toThrow(/SHA-256/u);
  });

  it("renders persisted presets, a supervisor-owned per-user launcher, and task registration", () => {
    expect(JSON.parse(renderNodePresetJson("controller"))).toMatchObject({
      preset: "controller",
      nodeType: "controller",
      capabilities: { execution: false, ui: true },
    });
    const launcher = renderWindowsNodeLauncherCmd();
    expect(launcher).toContain('set "JARVIS_NODE_PRESET=headless"');
    expect(launcher).toContain("JARVIS_NODE_STOP=%T3CODE_HOME%\\runtime\\windows-stop.marker");
    expect(launcher).toContain('cd /d "%~dp0"');
    expect(launcher).toContain('"%~dp0node\\node.exe" "%~dp0jarvis-node-supervisor.mjs"');
    expect(launcher).not.toContain("service-launcher.mjs");
    expect(launcher).toContain("goto run_supervisor");
    expect(launcher).toContain(":cleanup_orphan");
    expect(launcher).toContain(
      '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0jarvis-node-stop.ps1" -RuntimeRoot "%~dp0."',
    );
    expect(launcher).toContain("if errorlevel 1 goto cleanup_retry");
    expect(launcher).toContain(":cleanup_retry");
    expect(launcher).toContain("goto cleanup_orphan");
    expect(launcher).toContain("timeout /t 5 /nobreak >nul");

    const supervisor = renderWindowsNodeSupervisorMjs();
    expect(supervisor).toContain("fileURLToPath(import.meta.url)");
    expect(supervisor).toContain("process.execPath");
    expect(supervisor).toContain(
      '"--mode", "web", "--no-browser", "--port", "3773", "--jarvis-node-preset", "headless"',
    );
    expect(supervisor).toContain("cwd: runtimeRoot");
    expect(supervisor).toContain('JARVIS_NODE_PRESET: "headless"');
    expect(supervisor).toContain("setTimeout");
    expect(supervisor).toContain("5000");
    expect(supervisor).toContain("/PID");
    expect(supervisor).toContain("/T");
    expect(supervisor).toContain("/F");
    expect(supervisor).not.toContain("/IM");

    const stopPs1 = renderWindowsNodeStopPs1();
    expect(stopPs1).toContain("param([Parameter(Mandatory = $true)][string] $RuntimeRoot)");
    expect(stopPs1).toContain("$ErrorActionPreference = 'Stop'");
    expect(stopPs1).toContain("Join-Path $RuntimeRoot 'node\\node.exe'");
    expect(stopPs1).toContain("Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\"");
    expect(stopPs1).toContain("$bundledNode");
    expect(stopPs1).toContain("$_.ExecutablePath");
    expect(stopPs1).toContain("$taskkill");
    expect(stopPs1).toContain("/PID $process.ProcessId /T /F");
    expect(stopPs1).toContain("for ($attempt = 0; $attempt -lt 50; $attempt++)");
    expect(stopPs1).toContain("$remaining.Count -eq 0");
    expect(stopPs1).toContain("Write-Error");
    expect(stopPs1).toContain("exit 1");
    expect(stopPs1).not.toContain("/IM node.exe");

    const ownedStopPs1 = renderWindowsOwnedProcessStopPs1();
    expect(ownedStopPs1).toContain("[string] $DesktopPath");
    expect(ownedStopPs1).toContain("[string] $CompanionPath");
    expect(ownedStopPs1).toContain("[string] $LegacyCompanionPath");
    expect(ownedStopPs1).toContain(
      "$candidatePaths = @($DesktopPath, $CompanionPath, $LegacyCompanionPath)",
    );
    expect(ownedStopPs1).toContain("$allowedByPath = @{}");
    expect(ownedStopPs1).toContain("foreach ($candidate in $candidatePaths)");
    expect(ownedStopPs1).toContain("$allowedByPath[$full.ToLowerInvariant()] = $true");
    expect(ownedStopPs1).not.toContain("$AllowedPath =");
    expect(ownedStopPs1).toContain("Name = 'Jarvis.exe'");
    expect(ownedStopPs1).toContain("Name = 'Jarvis Companion.exe'");
    expect(ownedStopPs1).toContain("$_.ExecutablePath");
    expect(ownedStopPs1).toContain("ToLowerInvariant()");
    expect(ownedStopPs1).toContain("/PID $process.ProcessId /T /F");
    expect(ownedStopPs1).toContain("for ($attempt = 0; $attempt -lt 50; $attempt++)");
    expect(ownedStopPs1).toContain("$remaining.Count -eq 0");
    expect(ownedStopPs1).toContain("catch {");
    expect(ownedStopPs1).toContain("exit 1");
    expect(ownedStopPs1).not.toContain("/IM");

    const command = renderWindowsTaskCreateCommand(
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\Jarvis\\runtime-win\\jarvis-node-launcher.cmd",
    );
    expect(command).toBe(
      'schtasks.exe /Create /TN "Jarvis Headless Node" /SC ONLOGON /TR "C:\\Users\\Ada\\AppData\\Local\\Programs\\Jarvis\\runtime-win\\jarvis-node-launcher.cmd" /RL LIMITED /F',
    );
    const xml = renderWindowsTaskXml({
      launcherPath: "C:\\Jarvis\\runtime\\launcher.cmd",
      nodePath: "C:\\Jarvis\\runtime\\node\\node.exe",
    });
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  });

  it("runs the owned-process helper with nonexistent allowed paths on Windows", async () => {
    // This smoke test intentionally runs only on the host Windows runtime;
    // NodeOS.platform() is the direct Node boundary for that host check.
    // oxlint-disable-next-line t3code/no-global-process-runtime -- this test is a direct Node child-process smoke test and must skip on non-Windows hosts.
    if (NodeOS.platform() !== "win32") return;

    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-owned-stop-smoke-"));
    const script = NodePath.join(root, "jarvis-owned-process-stop.ps1");
    try {
      await NodeFSP.writeFile(script, renderWindowsOwnedProcessStopPs1());
      await NodeUtil.promisify(NodeChildProcess.execFile)("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-DesktopPath",
        NodePath.join(root, "missing-desktop", "Jarvis.exe"),
        "-CompanionPath",
        NodePath.join(root, "missing-companion", "Jarvis Companion.exe"),
      ]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("starts and stops the exact supervisor-owned child through its marker", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-supervisor-test-"));
    let supervisor: NodeChildProcess.ChildProcess | undefined;
    let childPid: number | undefined;
    try {
      const dist = NodePath.join(root, "dist");
      const runtime = NodePath.join(root, "node");
      await NodeFSP.mkdir(dist, { recursive: true });
      await NodeFSP.mkdir(runtime, { recursive: true });
      const marker = NodePath.join(root, "stop.marker");
      const pidFile = NodePath.join(root, "child.pid");
      const argsFile = NodePath.join(root, "child.args.json");
      await NodeFSP.writeFile(
        NodePath.join(dist, "bin.mjs"),
        `import * as fs from "node:fs/promises";
await fs.writeFile(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));
await fs.rename(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});
await fs.writeFile(${JSON.stringify(`${argsFile}.tmp`)}, JSON.stringify({ argv: process.argv.slice(2), preset: process.env.JARVIS_NODE_PRESET }));
await fs.rename(${JSON.stringify(`${argsFile}.tmp`)}, ${JSON.stringify(argsFile)});
setInterval(() => {}, 1000);
`,
      );
      const supervisorPath = NodePath.join(root, "jarvis-node-supervisor.mjs");
      await NodeFSP.writeFile(supervisorPath, renderWindowsNodeSupervisorMjs());
      const spawnedSupervisor = NodeChildProcess.spawn(process.execPath, [supervisorPath], {
        cwd: root,
        env: { ...process.env, JARVIS_NODE_STOP: marker, JARVIS_NODE_PRESET: "headless" },
        stdio: "ignore",
      });
      supervisor = spawnedSupervisor;
      const waitForFile = async (filePath: string): Promise<string> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            const content = await NodeFSP.readFile(filePath, "utf8");
            if (content.trim().length > 0) return content;
          } catch {}
          await NodeTimersPromises.setTimeout(25);
        }
        throw new Error(`Timed out waiting for ${filePath}`);
      };
      const capturedChildPid = Number(await waitForFile(pidFile));
      expect(Number.isSafeInteger(capturedChildPid)).toBe(true);
      expect(capturedChildPid).toBeGreaterThan(0);
      childPid = capturedChildPid;
      const childArgs = JSON.parse(await waitForFile(argsFile)) as {
        argv: string[];
        preset: string;
      };
      expect(childArgs.argv).toEqual([
        "--mode",
        "web",
        "--no-browser",
        "--port",
        "3773",
        "--jarvis-node-preset",
        "headless",
      ]);
      expect(childArgs.preset).toBe("headless");
      const exitPromise = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          spawnedSupervisor.once("error", reject);
          spawnedSupervisor.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      await NodeFSP.writeFile(marker, "stop\n");
      const exit = await Promise.race([
        exitPromise,
        NodeTimersPromises.setTimeout(5000).then(() => {
          throw new Error("Supervisor did not stop");
        }),
      ]);
      expect(exit.code).toBe(0);
      expect(() => process.kill(capturedChildPid, 0)).toThrow();
    } finally {
      if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill();
      }
      if (childPid !== undefined && Number.isSafeInteger(childPid) && childPid > 0) {
        try {
          process.kill(childPid, "SIGTERM");
        } catch {
          // The supervisor already reaped the captured child.
        }
      }
      if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => {
            supervisor?.once("exit", () => resolve());
            supervisor?.once("error", () => resolve());
          }),
          NodeTimersPromises.setTimeout(5000),
        ]);
      }
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("renders one outer mode-selecting installer with preserved user data", () => {
    const nsi = renderWindowsSetupNsi({
      version: "1.2.3",
      arch: "x64",
      outputPath: "C:\\out\\Jarvis-Setup-1.2.3-win-x64.exe",
      stageRoot: "C:\\stage\\jarvis",
      sevenZipPath: "C:\\tools\\7za.exe",
      iconPath: "C:\\stage\\jarvis.ico",
    });
    expect(nsi).toContain('OutFile "C:\\out\\Jarvis-Setup-1.2.3-win-x64.exe"');
    expect(nsi.indexOf("Unicode true")).toBeLessThan(nsi.indexOf('Name "Jarvis 1.2.3"'));
    expect(nsi).toContain("Full Node");
    expect(nsi).toContain("Controller Node");
    expect(nsi).toContain("Headless Node");
    expect(nsi).not.toContain("—");
    expect(nsi).toContain('!define MUI_ICON "C:\\stage\\jarvis.ico"');
    expect(nsi).toContain('BrandingText "Jarvis 1.2.3"');
    expect(nsi).toContain("!insertmacro MUI_PAGE_WELCOME");
    expect(nsi).toContain("!insertmacro MUI_PAGE_DIRECTORY");
    expect(nsi).toContain("!insertmacro MUI_PAGE_FINISH");
    expect(nsi).toContain("!insertmacro MUI_UNPAGE_CONFIRM");
    expect(nsi).toContain("!insertmacro MUI_UNPAGE_INSTFILES");
    expect(nsi).toContain("!insertmacro MUI_UNPAGE_FINISH");
    expect(nsi).toContain('!insertmacro MUI_LANGUAGE "English"');
    expect(nsi.indexOf('!insertmacro MUI_LANGUAGE "English"')).toBeGreaterThan(
      nsi.indexOf("!insertmacro MUI_UNPAGE_FINISH"),
    );
    expect(nsi).toContain('CreateShortCut "$DESKTOP\\Jarvis.lnk"');
    expect(nsi).toContain('CreateShortCut "$SMPROGRAMS\\Jarvis\\Jarvis.lnk"');
    expect(nsi).not.toContain("Jarvis Companion.lnk");
    expect(nsi).toContain('"DisplayName" "Jarvis"');
    expect(nsi).toContain('"DisplayVersion" "1.2.3"');
    expect(nsi).toContain('"Publisher" "Abstergo"');
    expect(nsi).toContain('"UninstallString"');
    expect(nsi).toContain('"QuietUninstallString"');
    expect(nsi).toContain("WriteRegDWORD HKCU");
    expect(nsi).toContain(
      'DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Jarvis"',
    );
    expect(nsi).toContain("IfErrors mode_from_existing 0");
    expect(nsi).toContain("schtasks.exe /Run");
    expect(nsi).toContain("payload-manifest.json");
    expect(nsi).toContain("Call ValidateStagedPayload");
    expect(nsi).toContain("IfSilent apps_close apps_prompt");
    expect(nsi).toContain('CreateDirectory "$INSTDIR\\.previous"');
    expect(nsi).toContain(
      'Rename "$INSTDIR\\payload-manifest.json" "$INSTDIR\\.previous\\payload-manifest.json"',
    );
    expect(nsi).toContain(
      'Rename "$INSTDIR\\.previous\\payload-manifest.json" "$INSTDIR\\payload-manifest.json"',
    );
    expect(nsi).toContain("Call RestorePreviousPayload");
    expect(nsi).toContain("Var RestoreFailed");
    expect(nsi).toContain('StrCpy $RestoreFailed "0"');
    expect(nsi).toContain('StrCmp $NewDesktopMoved "1" 0 restore_new_runtime');
    expect(nsi).toContain('StrCmp $PreviousDesktopMoved "1" 0 restore_runtime');
    expect(nsi).toContain("Function StopHeadlessNode");
    expect(nsi.match(/Call StopHeadlessNode/g)?.length).toBe(1);
    expect(nsi).toContain("Function un.StopHeadlessNode");
    expect(nsi).toContain("Call un.StopHeadlessNode");
    expect(nsi).toContain("Var StopHelperAvailable");
    expect(nsi).toContain("Var StopHelperPath");
    expect(nsi).toContain("Var StopFailed");
    expect(nsi).toContain("Var OwnedProcessPowerShellPath");
    expect(nsi).toContain("Var LegacyCompanionExecutable");
    expect(nsi).toContain("Function StopOwnedJarvisProcesses");
    expect(nsi).toContain("Function un.StopOwnedJarvisProcesses");
    expect(nsi).toContain(
      'StrCmp $LegacyCompanionExecutable "" stop_owned_without_legacy stop_owned_with_legacy',
    );
    expect(nsi).toContain(
      'StrCpy $OwnedProcessLegacyArgument " -LegacyCompanionPath $\\"$LegacyCompanionExecutable$\\""',
    );
    expect(nsi).toContain('StrCpy $OwnedProcessLegacyArgument ""');
    expect(nsi).toContain(
      '-File $\\"$PLUGINSDIR\\jarvis-owned-process-stop.ps1$\\" -DesktopPath $\\"$INSTDIR\\desktop\\Jarvis.exe$\\" -CompanionPath $\\"$INSTDIR\\companion\\Jarvis Companion.exe$\\" $OwnedProcessLegacyArgument',
    );
    expect(nsi).toContain("stop_owned_invoke:");
    const stopOwnedStart = nsi.indexOf("Function StopOwnedJarvisProcesses");
    const stopOwned = nsi.slice(stopOwnedStart, nsi.indexOf("FunctionEnd", stopOwnedStart));
    expect(stopOwned).toContain(
      'StrCpy $OwnedProcessPowerShellPath "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"',
    );
    expect(stopOwned).toContain(
      'IfFileExists "$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe" 0 +2',
    );
    expect(stopOwned).toContain("nsExec::ExecToStack");
    expect(stopOwned).toContain("Pop $R9\r\n  Pop $R8");
    expect(stopOwned).toContain("$TEMP\\jarvis-owned-process-stop-diagnostic.txt");
    expect(stopOwned).toContain("Owned process helper missing");
    expect(stopOwned).not.toContain("nsExec::ExecToLog");
    expect(nsi).toContain("jarvis-owned-process-stop.ps1");
    expect(nsi).toContain(
      'File /oname=jarvis-owned-process-stop.ps1 "C:\\stage\\jarvis\\jarvis-owned-process-stop.ps1"',
    );
    const installHelperStart = nsi.indexOf('Section "-Owned process shutdown helper"');
    const installHelper = nsi.slice(
      installHelperStart,
      nsi.indexOf("SectionEnd", installHelperStart),
    );
    const installInitPluginsDir = installHelper.indexOf("InitPluginsDir");
    const installSetOutPath = installHelper.indexOf('SetOutPath "$PLUGINSDIR"');
    const installHelperFile = installHelper.indexOf("File /oname=jarvis-owned-process-stop.ps1");
    expect(installInitPluginsDir).toBeGreaterThanOrEqual(0);
    expect(installSetOutPath).toBeGreaterThanOrEqual(0);
    expect(installHelperFile).toBeGreaterThanOrEqual(0);
    expect(installInitPluginsDir).toBeLessThan(installSetOutPath);
    expect(installSetOutPath).toBeLessThan(installHelperFile);
    const uninstallSectionStart = nsi.indexOf('Section "Uninstall"');
    const uninstallSection = nsi.slice(
      uninstallSectionStart,
      nsi.indexOf("SectionEnd", uninstallSectionStart),
    );
    const uninstallInitPluginsDir = uninstallSection.indexOf("InitPluginsDir");
    const uninstallSetOutPath = uninstallSection.indexOf('SetOutPath "$PLUGINSDIR"');
    const uninstallHelperFile = uninstallSection.indexOf(
      "File /oname=jarvis-owned-process-stop.ps1",
    );
    expect(uninstallInitPluginsDir).toBeGreaterThanOrEqual(0);
    expect(uninstallSetOutPath).toBeGreaterThanOrEqual(0);
    expect(uninstallHelperFile).toBeGreaterThanOrEqual(0);
    expect(uninstallInitPluginsDir).toBeLessThan(uninstallSetOutPath);
    expect(uninstallSetOutPath).toBeLessThan(uninstallHelperFile);
    expect(nsi).not.toContain("File /oname=$PLUGINSDIR\\jarvis-owned-process-stop.ps1");
    expect(nsi).toContain("Sleep 1500");
    expect(nsi).toContain("jarvis-node-supervisor.mjs");
    expect(nsi).toContain("jarvis-node-stop.ps1");
    expect(nsi).toContain("WindowsPowerShell\\v1.0\\powershell.exe");
    expect(nsi).toContain("-NoProfile -NonInteractive -ExecutionPolicy Bypass");
    expect(nsi).toContain("schtasks.exe /End /TN");
    expect(nsi).toContain("schtasks.exe /Delete /TN");
    const stopStart = nsi.indexOf("Function StopHeadlessNode");
    const stopFunction = nsi.slice(stopStart, nsi.indexOf("FunctionEnd", stopStart));
    expect(stopFunction).not.toContain('Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"');
    expect(stopFunction.indexOf("Sleep 1500")).toBeLessThan(stopFunction.indexOf("powershell.exe"));
    expect(stopFunction.indexOf("powershell.exe")).toBeLessThan(
      stopFunction.indexOf("schtasks.exe /End"),
    );
    expect(stopFunction.indexOf("schtasks.exe /End")).toBeLessThan(
      stopFunction.indexOf("schtasks.exe /Delete"),
    );
    expect(stopFunction).toContain("stop_headless_helper_second:");
    expect(stopFunction).toContain(
      'StrCmp $R9 "0" stop_headless_task_delete stop_headless_helper_failed',
    );
    expect(stopFunction).toContain("schtasks.exe /Query /TN");
    expect(stopFunction).toContain("stop_headless_task_query:");
    expect(stopFunction).toContain('StrCmp $R8 "50" stop_headless_task_query_failed 0');
    expect(stopFunction).toContain("stop_headless_task_query_failed:");
    expect(stopFunction).toContain("SetErrors");
    expect(stopFunction).toContain("stop_headless_plugin_helper:");
    const uninstallStopStart = nsi.indexOf("Function un.StopHeadlessNode");
    const uninstallStopFunction = nsi.slice(
      uninstallStopStart,
      nsi.indexOf("FunctionEnd", uninstallStopStart),
    );
    expect(uninstallStopFunction).toContain("un.stop_headless_plugin_helper:");
    const uninstallStart = nsi.indexOf('Section "Uninstall"');
    const uninstall = nsi.slice(uninstallStart, nsi.indexOf("SectionEnd", uninstallStart));
    expect(uninstall).toContain("Call un.StopHeadlessNode");
    expect(uninstall).toContain("ClearErrors");
    expect(uninstall).toContain("IfErrors un_stop_headless_failed 0");
    expect(uninstall).toContain('Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"');
    expect(uninstall).toContain("SetErrorLevel 5");
    expect(uninstall).toContain("un_stop_headless_interactive:");
    expect(uninstall.indexOf("IfErrors un_stop_headless_failed 0")).toBeLessThan(
      uninstall.indexOf('Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"'),
    );
    const resetStart = nsi.indexOf('Section "Reset old mode"');
    const reset = nsi.slice(resetStart, nsi.indexOf("SectionEnd", resetStart));
    expect(reset).toContain("ClearErrors");
    expect(reset).toContain("Call StopHeadlessNode");
    expect(reset).toContain("IfErrors reset_stop_failed 0");
    expect(reset).toContain("SetErrorLevel 5");
    expect(reset).toContain("reset_stop_interactive:");
    expect(nsi).toContain('StrCmp $PreviousHeadless "1" 0 staging_failure_message');
    expect(nsi).toContain("Function HandleStagingFailure");
    expect(nsi).toContain('RMDir /r "$INSTDIR\\.incoming"');
    expect(nsi).toContain('Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"');
    expect(nsi).toContain("stale UI/voice files");
    expect(nsi).toContain("jarvis-payload-complete.txt");
    expect(nsi).not.toContain("taskkill.exe /IM");
    expect(nsi).toContain("Call StopOwnedJarvisProcesses");
    expect(nsi).toContain("IfErrors owned_process_stop_abort 0");
    expect(nsi).toContain("Call un.StopOwnedJarvisProcesses");
    expect(nsi).toContain("IfErrors un_owned_process_stop_failed 0");
    expect(nsi).toContain(
      'StrCpy $OwnedProcessLegacyArgument " -LegacyCompanionPath $\\"$LegacyCompanionExecutable$\\""',
    );
    expect(nsi).toContain('StrCpy $LegacyCompanionExecutable "$R1\\Jarvis Companion.exe"');
    expect(nsi).toContain("Jarvis Companion.exe");
    expect(nsi).toContain("Function MigrateLegacyCompanion");
    expect(nsi).toContain(
      'ReadRegStr $R0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\0f1dda33-2afd-5844-b03e-82589eb138e8" "UninstallString"',
    );
    expect(nsi).toContain(
      'ReadRegStr $R1 HKCU "Software\\0f1dda33-2afd-5844-b03e-82589eb138e8" "InstallLocation"',
    );
    expect(nsi).toContain('IfFileExists "$R1\\Uninstall Jarvis Companion.exe"');
    expect(nsi).toContain(`ExecWait '"$R1\\Uninstall Jarvis Companion.exe" /S' $R2`);
    expect(nsi).not.toContain('ExecWait "$R1\\Uninstall Jarvis Companion.exe" /S $R2');
    expect(nsi).toContain("Call MigrateLegacyCompanion");
    expect(nsi).toContain("legacy_companion_migration_abort:");
    expect(nsi).toContain('Exec "$INSTDIR\\desktop\\Jarvis.exe"');
    expect(nsi).not.toContain("--jarvis-controller");
    expect(nsi).toContain('CreateShortCut "$DESKTOP\\Jarvis.lnk" "$INSTDIR\\desktop\\Jarvis.exe"');
    expect(nsi).toContain('SetOutPath "$INSTDIR\\.incoming"');
    expect(nsi).toContain("preserve $PROFILE\\.jarvis");
    expect(nsi).toContain("SetCompress off");
    expect(nsi).toContain('Section "-Embedded extractor" SEC_EXTRACTOR');
    expect(nsi.match(/^\s*File \/oname=\$PLUGINSDIR\\7za\.exe /gmu)?.length).toBe(1);
    expect(nsi).not.toContain("!addplugindir");
    expect(nsi).not.toContain("Nsis7z");
    expect(nsi.match(/^\s*File \/oname=\$PLUGINSDIR\\.*\.7z /gmu)?.length).toBe(2);
    expect(nsi).not.toContain("File /r");
    expect(nsi).not.toContain("Pop $OUTDIR");
    expect(nsi).not.toMatch(/^\s*Goto staged_commit_failed$/mu);
    expect(nsi.match(/^\s*nsExec::ExecToLog .*7za\.exe/gmu)?.length).toBe(2);
    expect(nsi.match(/Pop \$R1/gmu)?.length).toBe(2);
    expect(nsi.match(/StrCmp \$R1 "0"/gmu)?.length).toBe(2);
    const nsiLines = nsi.split(/\r?\n/u);
    nsiLines.forEach((line, index) => {
      if (line.includes("nsExec::ExecToLog")) {
        expect(nsiLines[index + 1]).toMatch(/^\s*Pop \$R(?:1|9)$/u);
      }
      if (
        line.trim().startsWith("Rename ") &&
        nsiLines[index + 1]?.trim().startsWith("IfErrors ")
      ) {
        expect(nsiLines[index - 1]?.trim()).toBe("ClearErrors");
      }
    });
    expect(
      nsiLines.filter(
        (line, index) =>
          line.trim().startsWith("Rename ") && nsiLines[index + 1]?.trim().startsWith("IfErrors "),
      ),
    ).toHaveLength(9);
    const failureStart = nsi.indexOf("Function HandleStagingFailure");
    const failureHandler = nsi.slice(failureStart, nsi.indexOf("FunctionEnd", failureStart));
    expect(failureHandler).toContain('StrCmp $PreviousHeadless "1" 0 staging_failure_message');
    expect(failureHandler.match(/nsExec::ExecToLog/g)?.length).toBe(2);
    expect(failureHandler.match(/Pop \$R9/g)?.length).toBe(2);
    expect(failureHandler).toContain("MessageBox MB_ICONSTOP");
    expect(failureHandler).toContain("Abort");
    expect(failureHandler).toContain("IfSilent staging_failure_silent staging_failure_interactive");
    expect(failureHandler).toContain("staging_failure_silent:");
    expect(failureHandler).toContain("SetErrorLevel 2");
    expect(failureHandler).toContain("Quit");
    expect(failureHandler).toContain("staging_failure_interactive:");
    const failureSequence = [
      'RMDir /r "$INSTDIR\\.incoming"',
      'Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"',
      'StrCmp $PreviousHeadless "1" 0 staging_failure_message',
      "MessageBox MB_ICONSTOP",
      "Abort",
    ].map((entry) => failureHandler.indexOf(entry));
    expect(failureSequence.every((index) => index >= 0)).toBe(true);
    expect(failureSequence).toEqual([...failureSequence].sort((a, b) => a - b));
    const validationStart = nsi.indexOf("Function ValidateStagedPayload");
    const validation = nsi.slice(validationStart, nsi.indexOf("FunctionEnd", validationStart));
    expect(validation.indexOf("Call HandleStagingFailure")).toBeLessThan(
      validation.indexOf("Abort"),
    );
    const restoreStart = nsi.indexOf("Function RestorePreviousPayload");
    const restoreHandler = nsi.slice(restoreStart, nsi.indexOf("FunctionEnd", restoreStart));
    expect(restoreHandler).toContain("IfSilent restore_silent restore_interactive");
    expect(restoreHandler).toContain("restore_silent:");
    expect(restoreHandler).toContain("SetErrorLevel 3");
    expect(restoreHandler).toContain("Quit");
    expect(restoreHandler).toContain("restore_interactive:");
    expect(restoreHandler).toContain("MessageBox MB_ICONSTOP");
    expect(restoreHandler).toContain("Abort");
    expect(
      restoreHandler.match(/IfErrors restore_[a-z_]+ (?:restore_[a-z_]+|restore_decision)/g)
        ?.length,
    ).toBe(6);
    expect(restoreHandler.match(/StrCpy \$RestoreFailed "1"/g)?.length).toBe(10);
    expect(restoreHandler).toContain('StrCmp $RestoreFailed "0" restore_task restore_failed');
    expect(restoreHandler).toContain('StrCmp $PreviousManifestMoved "1" 0 restore_decision');
    expect(restoreHandler).toContain(
      'IfFileExists "$INSTDIR\\.previous\\payload-manifest.json" restore_manifest_move restore_manifest_missing',
    );
    expect(restoreHandler).toContain("restore_decision:");
    expect(restoreHandler).toContain("restore_cleanup:");
    expect(restoreHandler).toContain("restore_failed:");
    expect(restoreHandler).toContain("IfSilent restore_failed_silent restore_failed_interactive");
    expect(restoreHandler).toContain("restore_failed_silent:");
    expect(restoreHandler).toContain("SetErrorLevel 4");
    expect(restoreHandler).toContain("restore_failed_interactive:");
    expect(restoreHandler).toContain("Recovery files, if present, remain at $INSTDIR\\.previous.");
    for (const [name, operation, next, failure] of [
      [
        "desktop",
        'RMDir /r "$INSTDIR\\desktop"',
        "restore_new_runtime",
        "restore_new_desktop_failed",
      ],
      [
        "runtime",
        'RMDir /r "$INSTDIR\\runtime-win"',
        "restore_new_manifest",
        "restore_new_runtime_failed",
      ],
      [
        "manifest",
        'Delete "$INSTDIR\\payload-manifest.json"',
        "restore_desktop",
        "restore_new_manifest_failed",
      ],
    ] as const) {
      const guard =
        name === "manifest"
          ? "NewManifestMoved"
          : `New${name[0]!.toUpperCase()}${name.slice(1)}Moved`;
      expect(restoreHandler).toContain(`StrCmp $${guard} "1" 0 ${next}`);
      const operationIndex = restoreHandler.indexOf(operation);
      expect(restoreHandler.slice(operationIndex - 30, operationIndex)).toContain("ClearErrors");
      expect(restoreHandler).toContain(`IfErrors ${failure} ${next}`);
      const failureIndex = restoreHandler.indexOf(`${failure}:`);
      expect(restoreHandler.indexOf('StrCpy $RestoreFailed "1"', failureIndex)).toBeGreaterThan(
        failureIndex,
      );
      expect(restoreHandler.indexOf(`Goto ${next}`, failureIndex)).toBeGreaterThan(failureIndex);
    }
    expect(restoreHandler).toContain('StrCmp $R9 "0" restore_task_run restore_task_failed');
    expect(restoreHandler).toContain('StrCmp $R9 "0" restore_task_complete restore_task_failed');
    expect(restoreHandler).toContain("restore_task_failed:");
    expect(restoreHandler).toContain('StrCpy $RestoreFailed "1"');
    expect(restoreHandler).toContain("Goto restore_failed");
    const taskCreateDecision = restoreHandler.indexOf(
      'StrCmp $R9 "0" restore_task_run restore_task_failed',
    );
    const taskRunDecision = restoreHandler.indexOf(
      'StrCmp $R9 "0" restore_task_complete restore_task_failed',
    );
    const restoreCleanup = restoreHandler.indexOf("restore_cleanup:");
    const previousDelete = restoreHandler.indexOf('RMDir /r "$INSTDIR\\.previous"');
    const restoreFailure = restoreHandler.indexOf("restore_failed:");
    expect(restoreCleanup).toBeGreaterThan(-1);
    expect(previousDelete).toBeGreaterThan(restoreCleanup);
    expect(restoreFailure).toBeGreaterThan(previousDelete);
    expect(
      restoreHandler.indexOf('RMDir /r "$INSTDIR\\.incoming"', restoreFailure),
    ).toBeGreaterThan(restoreFailure);
    const restoreDecision = restoreHandler.indexOf(
      'StrCmp $RestoreFailed "0" restore_task restore_failed',
    );
    const restoreDecisionLabel = restoreHandler.indexOf("restore_decision:");
    const restoreTask = restoreHandler.indexOf("restore_task:");
    const restoreTaskRestart = restoreHandler.indexOf("schtasks.exe /Run /TN");
    expect(restoreHandler).toContain('StrCpy $RestoreFailed "0"');
    expect(restoreDecision).toBeGreaterThan(-1);
    expect(restoreDecisionLabel).toBeGreaterThan(-1);
    expect(restoreDecisionLabel).toBeLessThan(restoreDecision);
    expect(restoreDecision).toBeLessThan(restoreTask);
    expect(restoreDecision).toBeLessThan(restoreTaskRestart);
    expect(taskCreateDecision).toBeGreaterThan(restoreTask);
    expect(taskRunDecision).toBeGreaterThan(taskCreateDecision);
    expect(taskRunDecision).toBeLessThan(restoreCleanup);
    for (const [name, next] of [
      ["desktop", "restore_runtime"],
      ["runtime-win", "restore_manifest"],
      ["payload-manifest.json", "restore_decision"],
    ] as const) {
      const label =
        name === "payload-manifest.json" ? "manifest" : name === "runtime-win" ? "runtime" : name;
      expect(restoreHandler).toContain(
        `IfFileExists "$INSTDIR\\.previous\\${name}" restore_${label}_move restore_${label}_missing`,
      );
      const missing = restoreHandler.indexOf(`restore_${label}_missing:`);
      const missingFailure = restoreHandler.indexOf('StrCpy $RestoreFailed "1"', missing);
      const missingNext = restoreHandler.indexOf(`Goto ${next}`, missingFailure);
      expect(missing).toBeGreaterThan(-1);
      expect(missingFailure).toBeGreaterThan(missing);
      expect(missingNext).toBeGreaterThan(missingFailure);
    }
    for (const [sectionName, archiveName] of [
      ["Desktop payload", "desktop"],
      ["Windows runtime payload", "runtime-win"],
    ] as const) {
      const sectionStart = nsi.indexOf(`Section "${sectionName}"`);
      const section = nsi.slice(sectionStart, nsi.indexOf("SectionEnd", sectionStart));
      const sequence = [
        "Push $OUTDIR",
        `File /oname=$PLUGINSDIR\\${archiveName}.7z`,
        `SetOutPath "$INSTDIR\\.incoming\\${archiveName}"`,
        "nsExec::ExecToLog",
        "Pop $R1",
        `Delete "$PLUGINSDIR\\${archiveName}.7z"`,
        "Pop $R0",
        "SetOutPath $R0",
        `StrCmp $R1 "0" ${archiveName === "runtime-win" ? "runtime_extract_done" : `${archiveName}_extract_done`} ${archiveName === "runtime-win" ? "runtime_extract_failed" : `${archiveName}_extract_failed`}`,
        `${archiveName === "runtime-win" ? "runtime" : archiveName}_extract_failed:`,
        "Call HandleStagingFailure",
        "Abort",
      ].map((entry) => section.indexOf(entry));
      expect(sequence.every((index) => index >= 0)).toBe(true);
      expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
      expect(section.match(/Pop \$R0/gmu)?.length).toBe(1);
      expect(section.match(/StrCmp \$R1 "0"/gmu)?.length).toBe(1);
      expect(section).not.toContain("Call ValidateStagedPayload");
      expect(section).toContain("$PLUGINSDIR\\7za.exe");
      expect(section).toContain("x -y -aoa -bb0 -bd");
      expect(section).toContain(`$INSTDIR\\.incoming\\${archiveName}`);
      expect(section).toContain("Call HandleStagingFailure");
      expect(section).toContain("Abort");
    }
    expect(nsi).toContain('StrCmp $NodeMode "headless" desktop_done');
    expect(nsi).toContain('StrCmp $NodeMode "headless" runtime_extract');
    expect(nsi).toContain('SetOutPath "$INSTDIR\\.incoming\\desktop"');
    expect(nsi).toContain('SetOutPath "$INSTDIR\\.incoming\\runtime-win"');
    expect(nsi).toContain('IfFileExists "$INSTDIR\\.incoming\\desktop\\Jarvis.exe"');
    expect(nsi).not.toContain(
      'IfFileExists "$INSTDIR\\.incoming\\companion\\Jarvis Companion.exe"',
    );
    expect(nsi).toContain('IfFileExists "$INSTDIR\\.incoming\\runtime-win\\node\\node.exe"');
    expect(nsi).toContain('IfFileExists "$INSTDIR\\.incoming\\runtime-win\\dist\\bin.mjs"');
    expect(nsi).toContain(
      'IfFileExists "$INSTDIR\\.incoming\\runtime-win\\jarvis-node-supervisor.mjs"',
    );
    expect(nsi).toContain('IfFileExists "$INSTDIR\\.incoming\\runtime-win\\jarvis-node-stop.ps1"');
    const stateGuiStart = nsi.indexOf("state_gui:");
    const stateGui = nsi.slice(stateGuiStart, nsi.indexOf("staged_commit_failed:", stateGuiStart));
    expect(stateGui).toContain('Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"');
    expect(nsi).toContain(
      'IfFileExists "$INSTDIR\\.incoming\\runtime-win\\jarvis-node-launcher.cmd"',
    );
    expect(nsi).toContain('FileWrite $0 "{$\\"product$\\":$\\"Jarvis');
    expect(nsi).toContain("MUI_FINISHPAGE_RUN");
    expect(windowsSetupArtifactName("1.2.3", "arm64")).toBe("Jarvis-Setup-1.2.3-win-arm64.exe");
    expect(
      renderWindowsSetupNsi({
        version: "1.2.3-beta.1",
        arch: "x64",
        outputPath: "C:\\out\\preview.exe",
        stageRoot: "C:\\stage\\preview",
        sevenZipPath: "C:\\tools\\7za.exe",
      }),
    ).toContain('VIProductVersion "1.2.3.0"');
  });

  it("keeps NSIS source bounded for a large synthetic manifest", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-setup-large-"));
    try {
      const dirs = {
        desktop: NodePath.join(root, "desktop"),
        runtimeWin: NodePath.join(root, "runtime-win"),
      };
      await Promise.all(Object.values(dirs).map((dir) => NodeFSP.mkdir(dir, { recursive: true })));
      await NodeFSP.writeFile(NodePath.join(dirs.desktop, "Jarvis.exe"), "desktop");
      await Promise.all(
        Array.from({ length: 32 }, (_, index) =>
          NodeFSP.mkdir(NodePath.join(dirs.runtimeWin, "node_modules", `package-${index}`), {
            recursive: true,
          }),
        ),
      );
      const runtimeFiles = Array.from({ length: 4096 }, (_, index) =>
        NodeFSP.writeFile(
          NodePath.join(
            dirs.runtimeWin,
            "node_modules",
            `package-${index % 32}`,
            `file-${index}.js`,
          ),
          "x",
        ),
      );
      await Promise.all(runtimeFiles);
      const manifest = await createWindowsSetupManifest({
        version: "1.2.3",
        arch: "x64",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        payloadDirectories: dirs,
      });
      expect(manifest.payloads[1]?.files.length).toBe(4096);
      const nsi = renderWindowsSetupNsi({
        version: "1.2.3",
        arch: "x64",
        outputPath: "C:\\out\\setup.exe",
        stageRoot: "C:\\stage",
        sevenZipPath: "C:\\tools\\7za.exe",
      });
      expect(nsi.match(/^\s*File \/oname=\$PLUGINSDIR\\.*\.7z /gmu)?.length).toBe(2);
      // Keep the generated control flow bounded while allowing the fixed
      // supervisor/shutdown protocol, owned-process guard, and their uninstall
      // mirrors to grow by a small, deliberate amount.
      expect(nsi.length).toBeLessThan(34_000);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
