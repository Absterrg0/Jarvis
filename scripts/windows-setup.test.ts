// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  createWindowsSetupProvenance,
  createWindowsSetupManifest,
  renderNodePresetJson,
  renderWindowsNodeLauncherCmd,
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
      companion: NodePath.join(root, "companion"),
      runtimeWin: NodePath.join(root, "runtime-win"),
    };
    await Promise.all(Object.values(dirs).map((dir) => NodeFSP.mkdir(dir, { recursive: true })));
    await NodeFSP.writeFile(NodePath.join(dirs.desktop, "Jarvis.exe"), "desktop");
    await NodeFSP.writeFile(NodePath.join(dirs.companion, "Jarvis Companion.exe"), "companion");
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
    expect(manifest.payloads.map(({ id }) => id)).toEqual(["desktop", "companion", "runtime-win"]);
    expect(manifest.payloads[0]?.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.payloads[2]?.modes).toEqual(["headless"]);
    expect(manifest.format).toBe(2);
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

  it("renders persisted presets, a restartable per-user launcher, and task registration", () => {
    expect(JSON.parse(renderNodePresetJson("controller"))).toMatchObject({
      preset: "controller",
      nodeType: "controller",
      capabilities: { execution: false, ui: true },
    });
    const launcher = renderWindowsNodeLauncherCmd();
    expect(launcher).toContain('set "JARVIS_NODE_PRESET=headless"');
    expect(launcher).toContain("JARVIS_NODE_STOP=%T3CODE_HOME%\\runtime\\windows-stop.marker");
    expect(launcher).toContain('cd /d "%~dp0"');
    expect(launcher).toContain(
      '"%~dp0node\\node.exe" "%~dp0dist\\bin.mjs" --mode web --no-browser --port 3773 --jarvis-node-preset headless',
    );
    expect(launcher).not.toContain("service-launcher.mjs");
    expect(launcher).toContain("goto run");

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

  it("renders one outer mode-selecting installer with preserved user data", () => {
    const nsi = renderWindowsSetupNsi({
      version: "1.2.3",
      arch: "x64",
      outputPath: "C:\\out\\Jarvis-Setup-1.2.3-win-x64.exe",
      stageRoot: "C:\\stage\\jarvis",
      sevenZipPath: "C:\\tools\\7za.exe",
    });
    expect(nsi).toContain('OutFile "C:\\out\\Jarvis-Setup-1.2.3-win-x64.exe"');
    expect(nsi.indexOf("Unicode true")).toBeLessThan(nsi.indexOf('Name "Jarvis 1.2.3"'));
    expect(nsi).toContain("Full Node");
    expect(nsi).toContain("Controller Node");
    expect(nsi).toContain("Headless Node");
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
    expect(nsi).toContain('StrCmp $NewDesktopMoved "1" 0 restore_new_companion');
    expect(nsi).toContain('StrCmp $PreviousDesktopMoved "1" 0 restore_companion');
    expect(nsi).toContain("schtasks.exe /End /TN");
    expect(nsi).toContain("Sleep 2000");
    expect(nsi).toContain('StrCmp $PreviousHeadless "1" 0 staging_failure_message');
    expect(nsi).toContain("Function HandleStagingFailure");
    expect(nsi).toContain('RMDir /r "$INSTDIR\\.incoming"');
    expect(nsi).toContain('Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"');
    expect(nsi).toContain("stale UI/voice files");
    expect(nsi).toContain("jarvis-payload-complete.txt");
    expect(nsi).toContain("taskkill.exe /IM");
    expect(nsi).toContain("Jarvis Companion.exe");
    expect(nsi).toContain('SetOutPath "$INSTDIR\\.incoming"');
    expect(nsi).toContain("preserve $PROFILE\\.jarvis");
    expect(nsi).toContain("SetCompress off");
    expect(nsi).toContain('Section "-Embedded extractor" SEC_EXTRACTOR');
    expect(nsi.match(/^\s*File \/oname=\$PLUGINSDIR\\7za\.exe /gmu)?.length).toBe(1);
    expect(nsi).not.toContain("!addplugindir");
    expect(nsi).not.toContain("Nsis7z");
    expect(nsi.match(/^\s*File \/oname=\$PLUGINSDIR\\.*\.7z /gmu)?.length).toBe(3);
    expect(nsi).not.toContain("File /r");
    expect(nsi).not.toContain("Pop $OUTDIR");
    expect(nsi).not.toMatch(/^\s*Goto staged_commit_failed$/mu);
    expect(nsi.match(/^\s*nsExec::ExecToLog .*7za\.exe/gmu)?.length).toBe(3);
    expect(nsi.match(/Pop \$R1/gmu)?.length).toBe(3);
    expect(nsi.match(/StrCmp \$R1 "0"/gmu)?.length).toBe(3);
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
    ).toHaveLength(12);
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
    ).toBe(8);
    expect(restoreHandler.match(/StrCpy \$RestoreFailed "1"/g)?.length).toBe(13);
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
        "restore_new_companion",
        "restore_new_desktop_failed",
      ],
      [
        "companion",
        'RMDir /r "$INSTDIR\\companion"',
        "restore_new_runtime",
        "restore_new_companion_failed",
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
      ["desktop", "restore_companion"],
      ["companion", "restore_runtime"],
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
      ["Companion payload", "companion"],
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
    expect(nsi).toContain('StrCmp $NodeMode "headless" companion_done');
    expect(nsi).toContain('StrCmp $NodeMode "headless" runtime_extract');
    expect(nsi).toContain('SetOutPath "$INSTDIR\\.incoming\\desktop"');
    expect(nsi).toContain('SetOutPath "$INSTDIR\\.incoming\\companion"');
    expect(nsi).toContain('SetOutPath "$INSTDIR\\.incoming\\runtime-win"');
    expect(nsi).toContain('IfFileExists "$INSTDIR\\.incoming\\desktop\\Jarvis.exe"');
    expect(nsi).toContain('IfFileExists "$INSTDIR\\.incoming\\companion\\Jarvis Companion.exe"');
    expect(nsi).toContain('IfFileExists "$INSTDIR\\.incoming\\runtime-win\\node\\node.exe"');
    expect(nsi).toContain('IfFileExists "$INSTDIR\\.incoming\\runtime-win\\dist\\bin.mjs"');
    expect(nsi).toContain(
      'IfFileExists "$INSTDIR\\.incoming\\runtime-win\\jarvis-node-launcher.cmd"',
    );
    expect(nsi).toContain('FileWrite $0 "{$\\"product$\\":$\\"Jarvis');
    expect(nsi).not.toContain("MUI_FINISHPAGE_RUN");
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
        companion: NodePath.join(root, "companion"),
        runtimeWin: NodePath.join(root, "runtime-win"),
      };
      await Promise.all(Object.values(dirs).map((dir) => NodeFSP.mkdir(dir, { recursive: true })));
      await NodeFSP.writeFile(NodePath.join(dirs.desktop, "Jarvis.exe"), "desktop");
      await NodeFSP.writeFile(NodePath.join(dirs.companion, "Jarvis Companion.exe"), "companion");
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
      expect(manifest.payloads[2]?.files.length).toBe(4096);
      const nsi = renderWindowsSetupNsi({
        version: "1.2.3",
        arch: "x64",
        outputPath: "C:\\out\\setup.exe",
        stageRoot: "C:\\stage",
        sevenZipPath: "C:\\tools\\7za.exe",
      });
      expect(nsi.match(/^\s*File \/oname=\$PLUGINSDIR\\.*\.7z /gmu)?.length).toBe(3);
      expect(nsi.length).toBeLessThan(20_000);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
