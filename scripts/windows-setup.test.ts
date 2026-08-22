// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  createWindowsSetupManifest,
  renderNodePresetJson,
  renderWindowsNodeLauncherCmd,
  renderWindowsSetupNsi,
  renderWindowsTaskCreateCommand,
  renderWindowsTaskXml,
  windowsSetupAliasName,
  windowsSetupArtifactName,
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
      payloadDirectories: dirs,
    });
    expect(manifest.artifactName).toBe("Jarvis-Setup-1.2.3-win-x64.exe");
    expect(windowsSetupAliasName()).toBe("Jarvis-Setup.exe");
    expect(manifest.payloads.map(({ id }) => id)).toEqual(["desktop", "companion", "runtime-win"]);
    expect(manifest.payloads[0]?.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.payloads[2]?.modes).toEqual(["headless"]);
  });

  it("renders persisted presets, a restartable per-user launcher, and task registration", () => {
    expect(JSON.parse(renderNodePresetJson("controller"))).toMatchObject({
      preset: "controller",
      nodeType: "controller",
      capabilities: { execution: false, ui: true },
    });
    const launcher = renderWindowsNodeLauncherCmd();
    expect(launcher).toContain("JARVIS_NODE_STOP=%T3CODE_HOME%\\runtime\\windows-stop.marker");
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
    });
    expect(nsi).toContain('OutFile "C:\\out\\Jarvis-Setup-1.2.3-win-x64.exe"');
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
    expect(nsi).toContain("stale UI/voice files");
    expect(nsi).toContain("jarvis-payload-complete.txt");
    expect(nsi).toContain("taskkill.exe /IM");
    expect(nsi).toContain("Jarvis Companion.exe");
    expect(nsi).toContain('SetOutPath "$INSTDIR\\.incoming"');
    expect(nsi).toContain("preserve $PROFILE\\.jarvis");
    expect(nsi).toContain('File /r "C:\\stage\\jarvis\\desktop\\*"');
    expect(nsi).toContain('FileWrite $0 "{$\\"product$\\":$\\"Jarvis');
    expect(nsi).not.toContain("MUI_FINISHPAGE_RUN");
    expect(windowsSetupArtifactName("1.2.3", "arm64")).toBe("Jarvis-Setup-1.2.3-win-arm64.exe");
    expect(
      renderWindowsSetupNsi({
        version: "1.2.3-beta.1",
        arch: "x64",
        outputPath: "C:\\out\\preview.exe",
        stageRoot: "C:\\stage\\preview",
      }),
    ).toContain('VIProductVersion "1.2.3.0"');
  });
});
