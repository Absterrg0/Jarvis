// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";

import {
  CIRCE_DESKTOP_PACKAGE_DESCRIPTION,
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

it("keeps Circe as the desktop product name with nightly staging", () => {
  assert.equal(desktopPackageJson.productName, "Circe");
  assert.equal(CIRCE_DESKTOP_PACKAGE_DESCRIPTION, "Circe desktop build");
  assert.equal(resolveDesktopProductName("0.0.17"), "Circe");
  assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Circe (Nightly)");
});

it("keeps Circe installer artwork on the existing visual system", () => {
  for (const name of ["dmg-background-latest.svg", "dmg-background-nightly.svg"]) {
    const artwork = NodeFS.readFileSync(
      new URL(`../apps/desktop/resources/dmg/${name}`, import.meta.url),
      "utf8",
    );
    assert.include(artwork, "Circe");
    assert.include(artwork, "Drag Circe to Applications");
  }
});

it("brands web boot and the PWA manifest while keeping storage keys", () => {
  const indexHtml = readSource("../apps/web/index.html");
  assert.include(indexHtml, "<title>Circe (Alpha)</title>");
  assert.include(indexHtml, 'aria-label="Circe splash screen"');
  assert.include(indexHtml, 'alt="Circe"');
  assert.include(indexHtml, "t3code:themes:v1");

  const manifest = JSON.parse(readSource("../apps/web/public/manifest.webmanifest")) as {
    readonly id?: string;
    readonly name?: string;
    readonly short_name?: string;
  };
  assert.equal(manifest.id, "/");
  assert.equal(manifest.name, "Circe");
  assert.equal(manifest.short_name, "Circe");
});

it("brands the palette, overlay, and portal scope without renaming routes", () => {
  const palette = readSource("../apps/web/src/components/CommandPalette.tsx");
  assert.include(palette, 'title: "Open Circe"');
  assert.include(palette, "Open the Circe command center");
  assert.include(palette, 'value: "action:circe"');

  const overlay = readSource("../apps/desktop/src/shell/DesktopCirceOverlay.ts");
  assert.include(overlay, "Circe is idle");
  assert.include(overlay, "Circe. Activate to choose providers and running agents.");
  assert.notInclude(overlay, "ARIS");
  assert.notInclude(overlay, "Jarvis");

  const portalScope = readSource("../apps/desktop/src/shell/DesktopLinuxPortalAppScope.ts");
  assert.include(portalScope, "Circe (${input.appId})");
  assert.include(portalScope, "input.appId");
});

it("brands mobile product copy while keeping route and scheme identities", () => {
  const theme = readSource("../apps/mobile/src/lib/mobileTheme.ts");
  assert.include(theme, 'label: "Circe"');

  const push = readSource(
    "../apps/mobile/src/features/agent-awareness/expoPushRegistrationNative.ts",
  );
  assert.include(push, '"Circe tasks"');

  const activity = readSource("../apps/mobile/src/features/agent-awareness/remoteRegistration.ts");
  assert.include(activity, 'title: "Circe"');

  const stack = readSource("../apps/mobile/src/Stack.tsx");
  assert.include(stack, 'initialRouteName: "Circe"');

  const appConfig = readSource("../apps/mobile/app.config.ts");
  assert.include(appConfig, '"Circe Dev"');
  assert.include(appConfig, 'scheme: "t3code-dev"');
  assert.include(appConfig, 'scheme: "t3code-preview"');
  assert.include(appConfig, 'scheme: "t3code"');
});

it("brands mesh and command prompts without touching identifiers", () => {
  const mesh = readSource("../packages/circe-client-runtime/src/circe/mesh.ts");
  assert.include(mesh, "Circe catalog unavailable.");
  assert.include(mesh, "CirceMeshNodeUnavailableError");

  const command = readSource("../packages/circe-core/src/command.ts");
  assert.include(command, "recent Circe task");
  assert.include(command, "Circe does one action per turn");
  assert.include(command, "What should Circe do after that task?");
  assert.include(command, "CirceCommandNeedsInput");

  const reporter = readSource("../apps/web/src/components/circe/CirceVoiceReporter.tsx");
  assert.include(reporter, "Circe voice delivery failed");
});

it("keeps migration identities and upstream references intact", () => {
  const migrations = readSource("../apps/server/src/persistence/Migrations.ts");
  assert.include(migrations, '"CirceTaskDesks"');
  assert.include(migrations, '"CircePushRegistrations"');

  const probe = readSource("../apps/desktop/src/app/DesktopStartupProbe.ts");
  assert.include(probe, 'readonly product: "Circe"');

  const desktopEnv = readSource("../apps/desktop/src/app/DesktopEnvironment.ts");
  assert.include(desktopEnv, "https://github.com/Absterrg0/Circe/releases/tag");

  const branding = readSource("../apps/web/src/branding.ts");
  assert.include(branding, "https://github.com/pingdotgg/t3code/releases/tag");

  const triagePlaybook = readSource("../apps/server/src/cli/triagePrompt.ts");
  assert.include(triagePlaybook, "https://github.com/pingdotgg/t3code");

  const installDoc = readSource("../docs/user/install.md");
  assert.include(installDoc, "`Circe-Setup.exe`");
  assert.include(installDoc, "Circe-<version>-x86_64.AppImage");
});

it("brands Windows installer display and install identities as Circe", () => {
  assert.equal(windowsSetupArtifactName("1.2.3", "x64"), "Circe-Setup-1.2.3-win-x64.exe");
  assert.equal(windowsSetupAliasName(), "Circe-Setup.exe");
  assert.equal(WINDOWS_SETUP_TASK_NAME, "Circe Headless Node");
  assert.equal(
    WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY,
    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Circe",
  );

  const nsi = renderWindowsSetupNsi({
    version: "1.2.3",
    arch: "x64",
    outputPath: "C:\\out\\Circe-Setup-1.2.3-win-x64.exe",
    stageRoot: "C:\\stage\\circe",
    sevenZipPath: "C:\\tools\\7za.exe",
  });
  for (const display of [
    "Welcome to Circe Setup",
    "Install Circe as a Full",
    "Launch Circe",
    'Name "Circe 1.2.3"',
    'BrandingText "Circe 1.2.3"',
    '"ProductName" "Circe"',
    '"FileDescription" "Circe Node setup"',
    '"DisplayName" "Circe"',
    "runs Circe",
    "Close Circe before continuing",
  ]) {
    assert.include(nsi, display);
  }
  for (const identity of [
    'InstallDir "$LOCALAPPDATA\\Programs\\Circe"',
    'InstallDirRegKey HKCU "Software\\Circe"',
    "$INSTDIR\\desktop\\Circe.exe",
    '"$INSTDIR\\Uninstall Circe.exe"',
    "Circe Headless Node",
  ]) {
    assert.include(nsi, identity);
  }
  assert.notInclude(nsi, "ARIS");
  assert.notInclude(nsi, "Jarvis");

  const ownedStop = renderWindowsOwnedProcessStopPs1();
  assert.include(ownedStop, "Name = 'Circe.exe'");
  assert.include(ownedStop, "Owned Circe processes remain");
});
