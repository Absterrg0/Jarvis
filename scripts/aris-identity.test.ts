// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";

import {
  JARVIS_DESKTOP_PACKAGE_DESCRIPTION,
  resolveDesktopProductName,
} from "./build-desktop-artifact.ts";
import {
  renderWindowsOwnedProcessStopPs1,
  renderWindowsSetupNsi,
  windowsSetupAliasName,
  windowsSetupArtifactName,
  WINDOWS_SETUP_TASK_NAME,
  WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY,
} from "./windows-setup.ts";
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

const readSource = (relativePath: string): string =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

it("keeps ARIS as the desktop product name with nightly staging", () => {
  assert.equal(desktopPackageJson.productName, "ARIS");
  assert.equal(JARVIS_DESKTOP_PACKAGE_DESCRIPTION, "ARIS desktop build");
  assert.equal(resolveDesktopProductName("0.0.17"), "ARIS");
  assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "ARIS (Nightly)");
});

it("keeps ARIS installer artwork on the existing visual system", () => {
  for (const name of ["dmg-background-latest.svg", "dmg-background-nightly.svg"]) {
    const artwork = NodeFS.readFileSync(
      new URL(`../apps/desktop/resources/dmg/${name}`, import.meta.url),
      "utf8",
    );
    assert.include(artwork, "ARIS");
    assert.include(artwork, "Drag ARIS to Applications");
  }
});

it("brands web boot and the PWA manifest while keeping storage keys", () => {
  const indexHtml = readSource("../apps/web/index.html");
  assert.include(indexHtml, "<title>ARIS (Alpha)</title>");
  assert.include(indexHtml, 'aria-label="ARIS splash screen"');
  assert.include(indexHtml, 'alt="ARIS"');
  assert.include(indexHtml, "t3code:themes:v1");

  const manifest = JSON.parse(readSource("../apps/web/public/manifest.webmanifest")) as {
    readonly id?: string;
    readonly name?: string;
    readonly short_name?: string;
  };
  assert.equal(manifest.id, "/");
  assert.equal(manifest.name, "ARIS");
  assert.equal(manifest.short_name, "ARIS");
});

it("brands the palette, overlay, and portal scope without renaming routes", () => {
  const palette = readSource("../apps/web/src/components/CommandPalette.tsx");
  assert.include(palette, 'title: "Open ARIS"');
  assert.include(palette, "Open the ARIS command center");
  assert.include(palette, 'value: "action:jarvis"');

  const overlay = readSource("../apps/desktop/src/shell/DesktopJarvisOverlay.ts");
  assert.include(overlay, "ARIS is idle");
  assert.include(overlay, "ARIS. Activate to choose providers and running agents.");
  assert.notInclude(overlay, "Jarvis is");

  const portalScope = readSource("../apps/desktop/src/shell/DesktopLinuxPortalAppScope.ts");
  assert.include(portalScope, "ARIS (${input.appId})");
  assert.include(portalScope, "input.appId");
});

it("brands mobile product copy while keeping route and scheme identities", () => {
  const theme = readSource("../apps/mobile/src/lib/mobileTheme.ts");
  assert.include(theme, 'label: "ARIS"');

  const push = readSource(
    "../apps/mobile/src/features/agent-awareness/expoPushRegistrationNative.ts",
  );
  assert.include(push, '"ARIS tasks"');

  const activity = readSource("../apps/mobile/src/features/agent-awareness/remoteRegistration.ts");
  assert.include(activity, 'title: "ARIS"');

  const stack = readSource("../apps/mobile/src/Stack.tsx");
  assert.include(stack, 'initialRouteName: "Jarvis"');

  const appConfig = readSource("../apps/mobile/app.config.ts");
  assert.include(appConfig, '"ARIS Dev"');
  assert.include(appConfig, 'scheme: "t3code-dev"');
  assert.include(appConfig, 'scheme: "t3code-preview"');
  assert.include(appConfig, 'scheme: "t3code"');
});

it("brands mesh and command prompts without touching identifiers", () => {
  const mesh = readSource("../packages/jarvis-client-runtime/src/jarvis/mesh.ts");
  assert.include(mesh, "ARIS catalog unavailable.");
  assert.include(mesh, "JarvisMeshNodeUnavailableError");

  const command = readSource("../packages/jarvis-core/src/command.ts");
  assert.include(command, "recent ARIS task");
  assert.include(command, "ARIS does one action per turn");
  assert.include(command, "What should ARIS do after that task?");
  assert.include(command, "JarvisCommandNeedsInput");

  const reporter = readSource("../apps/web/src/components/jarvis/JarvisVoiceReporter.tsx");
  assert.include(reporter, "ARIS voice delivery failed");
});

it("keeps installed identities and upstream references intact", () => {
  const migrations = readSource("../apps/server/src/persistence/Migrations.ts");
  assert.include(migrations, '"JarvisTaskDesks"');
  assert.include(migrations, '"JarvisPushRegistrations"');

  const probe = readSource("../apps/desktop/src/app/DesktopStartupProbe.ts");
  assert.include(probe, 'readonly product: "Jarvis"');

  const desktopEnv = readSource("../apps/desktop/src/app/DesktopEnvironment.ts");
  assert.include(desktopEnv, "https://github.com/Absterrg0/Jarvis/releases/tag");

  const branding = readSource("../apps/web/src/branding.ts");
  assert.include(branding, "https://github.com/pingdotgg/t3code/releases/tag");

  const triagePlaybook = readSource("../apps/server/src/cli/triagePrompt.ts");
  assert.include(triagePlaybook, "https://github.com/pingdotgg/t3code");

  const installDoc = readSource("../docs/user/install.md");
  assert.include(installDoc, "`Jarvis-Setup.exe`");
  assert.include(installDoc, "Jarvis-<version>-x86_64.AppImage");
});

it("brands Windows installer display as ARIS while keeping install identities Jarvis", () => {
  assert.equal(windowsSetupArtifactName("1.2.3", "x64"), "Jarvis-Setup-1.2.3-win-x64.exe");
  assert.equal(windowsSetupAliasName(), "Jarvis-Setup.exe");
  assert.equal(WINDOWS_SETUP_TASK_NAME, "Jarvis Headless Node");
  assert.equal(
    WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY,
    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Jarvis",
  );

  const nsi = renderWindowsSetupNsi({
    version: "1.2.3",
    arch: "x64",
    outputPath: "C:\\out\\Jarvis-Setup-1.2.3-win-x64.exe",
    stageRoot: "C:\\stage\\jarvis",
    sevenZipPath: "C:\\tools\\7za.exe",
  });
  for (const display of [
    "Welcome to ARIS Setup",
    "Install ARIS as a Full",
    "Launch ARIS",
    'Name "ARIS 1.2.3"',
    'BrandingText "ARIS 1.2.3"',
    '"ProductName" "ARIS"',
    '"FileDescription" "ARIS Node setup"',
    '"DisplayName" "ARIS"',
    "runs ARIS",
    "Close ARIS before continuing",
  ]) {
    assert.include(nsi, display);
  }
  for (const identity of [
    'InstallDir "$LOCALAPPDATA\\Programs\\Jarvis"',
    'InstallDirRegKey HKCU "Software\\Jarvis"',
    "$INSTDIR\\desktop\\Jarvis.exe",
    '"$INSTDIR\\Uninstall Jarvis.exe"',
    "Jarvis Headless Node",
  ]) {
    assert.include(nsi, identity);
  }
  assert.notInclude(nsi, '"DisplayName" "Jarvis"');
  assert.notInclude(nsi, "Welcome to Jarvis Setup");

  const ownedStop = renderWindowsOwnedProcessStopPs1();
  assert.include(ownedStop, "Name = 'Jarvis.exe'");
  assert.include(ownedStop, "Owned ARIS processes remain");
});
