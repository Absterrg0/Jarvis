// @effect-diagnostics nodeBuiltinImport:off

// Pure Windows installer contracts.  The actual NSIS compiler is only
// available on Windows CI; keeping payload discovery, hashes, mode state, and
// command rendering here makes the important parts testable on Linux.

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const WINDOWS_SETUP_MODES = ["full", "controller", "headless"] as const;
export type WindowsSetupMode = (typeof WINDOWS_SETUP_MODES)[number];
export type WindowsSetupArch = "x64" | "arm64";

export const WINDOWS_SETUP_TASK_NAME = "Jarvis Headless Node";
export const WINDOWS_SETUP_DATA_ROOT = "%USERPROFILE%\\.jarvis";

export interface WindowsSetupPayloadFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface WindowsSetupPayload {
  readonly id: "desktop" | "companion" | "runtime-win";
  readonly modes: ReadonlyArray<WindowsSetupMode>;
  readonly files: ReadonlyArray<WindowsSetupPayloadFile>;
}

export interface WindowsSetupManifest {
  readonly format: 2;
  readonly product: "Jarvis";
  readonly version: string;
  readonly platform: "windows";
  readonly arch: WindowsSetupArch;
  readonly artifactName: string;
  readonly sourceCommit: string;
  readonly payloads: ReadonlyArray<WindowsSetupPayload>;
}

export interface WindowsSetupManifestInput {
  readonly version: string;
  readonly arch: WindowsSetupArch;
  readonly sourceCommit: string;
  readonly payloadDirectories: Readonly<{
    readonly desktop: string;
    readonly companion: string;
    readonly runtimeWin: string;
  }>;
}

export interface WindowsSetupProvenance {
  readonly format: 1;
  readonly product: "Jarvis";
  readonly artifactName: string;
  readonly artifactSha256: string;
  readonly aliasName: string;
  readonly manifestName: string;
  readonly manifestSha256: string;
  readonly provenanceName: string;
  readonly sourceCommit: string;
  readonly version: string;
  readonly arch: WindowsSetupArch;
}

export interface WindowsSetupProvenanceInput {
  readonly artifactName: string;
  readonly artifactSha256: string;
  readonly aliasName: string;
  readonly manifestName: string;
  readonly manifestSha256: string;
  readonly provenanceName: string;
  readonly sourceCommit: string;
  readonly version: string;
  readonly arch: WindowsSetupArch;
}

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const WINDOWS_ARCHES = new Set<WindowsSetupArch>(["x64", "arm64"]);

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Windows setup version must be exact semver, received '${version}'.`);
  }
}

export function assertWindowsSetupSourceCommit(value: string): void {
  if (!SOURCE_COMMIT_PATTERN.test(value)) {
    throw new Error(`Windows setup source commit must be a full SHA-1, received '${value}'.`);
  }
}

export function assertWindowsSetupArch(value: string): asserts value is WindowsSetupArch {
  if (!WINDOWS_ARCHES.has(value as WindowsSetupArch)) {
    throw new Error(`Windows setup architecture must be x64 or arm64, received '${value}'.`);
  }
}

export function windowsSetupArtifactName(version: string, arch: WindowsSetupArch): string {
  assertVersion(version);
  return `Jarvis-Setup-${version}-win-${arch}.exe`;
}

export function windowsSetupManifestName(version: string, arch: WindowsSetupArch): string {
  return `${windowsSetupArtifactName(version, arch)}.manifest.json`;
}

export function windowsSetupProvenanceName(version: string, arch: WindowsSetupArch): string {
  return `${windowsSetupArtifactName(version, arch)}.provenance.json`;
}

export function windowsSetupAliasName(): string {
  return "Jarvis-Setup.exe";
}

export function windowsSetupModeCapabilities(mode: WindowsSetupMode) {
  return {
    ui: mode !== "headless",
    parakeet: mode !== "headless",
    kokoro: mode !== "headless",
    execution: mode !== "controller",
    projects: mode !== "controller",
    providers: mode !== "controller",
  } as const;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll(NodePath.sep, "/");
  if (normalized.startsWith("../") || normalized === ".." || NodePath.isAbsolute(normalized)) {
    throw new Error(`Payload path escapes its staging root: ${value}`);
  }
  return normalized;
}

async function collectPayloadFiles(
  rootDir: string,
): Promise<ReadonlyArray<WindowsSetupPayloadFile>> {
  const output: Array<WindowsSetupPayloadFile> = [];

  async function visit(directory: string): Promise<void> {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Payload contains unsupported non-file entry: ${absolutePath}`);
      }
      const bytes = await NodeFSP.readFile(absolutePath);
      output.push({
        path: normalizeRelativePath(NodePath.relative(rootDir, absolutePath)),
        bytes: bytes.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  await visit(rootDir);
  return output;
}

export async function createWindowsSetupManifest(
  input: WindowsSetupManifestInput,
): Promise<WindowsSetupManifest> {
  assertVersion(input.version);
  assertWindowsSetupArch(input.arch);
  assertWindowsSetupSourceCommit(input.sourceCommit);
  const payloads = await Promise.all([
    collectPayloadFiles(input.payloadDirectories.desktop).then((files) => ({
      id: "desktop" as const,
      modes: ["full", "controller"] as const,
      files,
    })),
    collectPayloadFiles(input.payloadDirectories.companion).then((files) => ({
      id: "companion" as const,
      modes: ["full", "controller"] as const,
      files,
    })),
    collectPayloadFiles(input.payloadDirectories.runtimeWin).then((files) => ({
      id: "runtime-win" as const,
      modes: ["headless"] as const,
      files,
    })),
  ]);
  return {
    format: 2,
    product: "Jarvis",
    version: input.version,
    platform: "windows",
    arch: input.arch,
    artifactName: windowsSetupArtifactName(input.version, input.arch),
    sourceCommit: input.sourceCommit,
    payloads,
  };
}

export function createWindowsSetupProvenance(
  input: WindowsSetupProvenanceInput,
): WindowsSetupProvenance {
  assertVersion(input.version);
  assertWindowsSetupArch(input.arch);
  assertWindowsSetupSourceCommit(input.sourceCommit);
  for (const [label, value] of [
    ["artifact", input.artifactSha256],
    ["manifest", input.manifestSha256],
  ] as const) {
    if (!SHA256_PATTERN.test(value)) {
      throw new Error(`Windows setup ${label} SHA-256 must be 64 lowercase hex characters.`);
    }
  }
  return {
    format: 1,
    product: "Jarvis",
    artifactName: input.artifactName,
    artifactSha256: input.artifactSha256,
    aliasName: input.aliasName,
    manifestName: input.manifestName,
    manifestSha256: input.manifestSha256,
    provenanceName: input.provenanceName,
    sourceCommit: input.sourceCommit,
    version: input.version,
    arch: input.arch,
  };
}

export function renderNodePresetJson(mode: WindowsSetupMode): string {
  const capabilities = windowsSetupModeCapabilities(mode);
  return `${JSON.stringify(
    {
      product: "Jarvis",
      preset: mode,
      nodeType: mode,
      capabilities,
    },
    null,
    2,
  )}\n`;
}

/** Stable launcher used by Task Scheduler. It does not depend on PATH. */
export function renderWindowsNodeLauncherCmd(): string {
  return [
    "@echo off",
    "setlocal enableextensions",
    `set "T3CODE_HOME=%USERPROFILE%\\.jarvis"`,
    `set "JARVIS_NODE_STOP=%T3CODE_HOME%\\runtime\\windows-stop.marker"`,
    ":run",
    'if exist "%JARVIS_NODE_STOP%" exit /b 0',
    `"%~dp0node\\node.exe" "%~dp0service-launcher.mjs"`,
    'if exist "%JARVIS_NODE_STOP%" exit /b 0',
    "timeout /t 5 /nobreak >nul",
    "goto run",
    "",
  ].join("\r\n");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Rendered for diagnostics and future COM-based registration. The installer
 * currently uses schtasks /Create because it works without an elevation prompt. */
export function renderWindowsTaskCreateCommand(launcherPath: string): string {
  return `schtasks.exe /Create /TN "${WINDOWS_SETUP_TASK_NAME}" /SC ONLOGON /TR "${launcherPath}" /RL LIMITED /F`;
}

export function renderWindowsTaskXml(input: {
  readonly launcherPath: string;
  readonly nodePath: string;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
    '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
    "  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>",
    `  <Actions Context="Author"><Exec><Command>${xmlEscape(input.launcherPath)}</Command><Arguments></Arguments><WorkingDirectory>${xmlEscape(NodePath.dirname(input.nodePath))}</WorkingDirectory></Exec></Actions>`,
    "</Task>",
    "",
  ].join("\r\n");
}

function nsiQuote(value: string): string {
  // NSIS uses `$\"` (not a C-style backslash) for an embedded quote.
  return `"${value.replaceAll('"', '$\\"')}"`;
}

function windowsPath(value: string): string {
  return value.replaceAll("/", "\\");
}

/**
 * Generate a self-contained NSIS source. Payload files are compiled into the
 * installer but are only extracted by their selected section; Headless never
 * leaves the UI or speech payload on disk.
 */
export function renderWindowsSetupNsi(input: {
  readonly version: string;
  readonly arch: WindowsSetupArch;
  readonly outputPath: string;
  readonly stageRoot: string;
}): string {
  assertVersion(input.version);
  assertWindowsSetupArch(input.arch);
  const numericFileVersion = `${input.version.split(/[-+]/u, 1)[0]}.0`;
  const stage = (name: string) => `${windowsPath(input.stageRoot)}\\${name}`;
  const desktopStage = stage("desktop");
  const companionStage = stage("companion");
  const runtimeStage = stage("runtime-win");
  return [
    "Unicode true",
    '!include "MUI2.nsh"',
    '!include "LogicLib.nsh"',
    '!include "nsDialogs.nsh"',
    '!include "FileFunc.nsh"',
    `Name "Jarvis ${input.version}"`,
    `OutFile ${nsiQuote(input.outputPath)}`,
    'InstallDir "$LOCALAPPDATA\\Programs\\Jarvis"',
    'InstallDirRegKey HKCU "Software\\Jarvis" "InstallLocation"',
    "RequestExecutionLevel user",
    `VIProductVersion "${numericFileVersion}"`,
    `VIAddVersionKey /LANG=1033 "ProductName" "Jarvis"`,
    `VIAddVersionKey /LANG=1033 "ProductVersion" "${input.version}"`,
    `VIAddVersionKey /LANG=1033 "FileDescription" "Jarvis Node setup"`,
    "!define MUI_ABORTWARNING",
    "Var NodeMode",
    "Var ExistingMode",
    "Var ModeFromCli",
    "Var FullRadio",
    "Var ControllerRadio",
    "Var HeadlessRadio",
    "Var ModePageHandle",
    "Var PreviousHeadless",
    "Var PreviousManifestMoved",
    "Var PreviousDesktopMoved",
    "Var PreviousCompanionMoved",
    "Var PreviousRuntimeMoved",
    "Var NewManifestMoved",
    "Var NewDesktopMoved",
    "Var NewCompanionMoved",
    "Var NewRuntimeMoved",
    "Page custom ModePageCreate ModePageLeave",
    "Page instfiles",
    "",
    "Function .onInit",
    '  StrCpy $NodeMode ""',
    '  StrCpy $ExistingMode ""',
    '  StrCpy $ModeFromCli ""',
    '  StrCpy $PreviousHeadless "0"',
    '  StrCpy $PreviousManifestMoved "0"',
    '  StrCpy $PreviousDesktopMoved "0"',
    '  StrCpy $PreviousCompanionMoved "0"',
    '  StrCpy $PreviousRuntimeMoved "0"',
    '  StrCpy $NewManifestMoved "0"',
    '  StrCpy $NewDesktopMoved "0"',
    '  StrCpy $NewCompanionMoved "0"',
    '  StrCpy $NewRuntimeMoved "0"',
    "  ${GetParameters} $0",
    '  ${GetOptions} $0 "/MODE=" $1',
    "  IfErrors mode_from_existing 0",
    "  StrCpy $NodeMode $1",
    '  StrCpy $ModeFromCli "1"',
    "  Goto mode_validate",
    "mode_from_existing:",
    '  ReadINIStr $ExistingMode "$PROFILE\\.jarvis\\config\\preset.ini" Jarvis Preset',
    "  StrCpy $NodeMode $ExistingMode",
    "mode_validate:",
    '  StrCmp $NodeMode "" 0 mode_validate_value',
    '  StrCpy $NodeMode "full"',
    "mode_validate_value:",
    '  StrCmp $NodeMode "full" mode_valid 0',
    '  StrCmp $NodeMode "controller" mode_valid 0',
    '  StrCmp $NodeMode "headless" mode_valid 0',
    '  StrCmp $ModeFromCli "1" mode_invalid_cli 0',
    '  StrCpy $NodeMode "full"',
    "  Goto mode_valid",
    "mode_invalid_cli:",
    '  MessageBox MB_ICONSTOP "MODE must be full, controller, or headless."',
    "  Quit",
    "mode_valid:",
    "FunctionEnd",
    "",
    "Function ModePageCreate",
    "  nsDialogs::Create 1018",
    "  Pop $ModePageHandle",
    "  ${If} $ModePageHandle == error",
    "    Abort",
    "  ${EndIf}",
    '  ${NSD_CreateLabel} 0 0 100% 18u "Choose how this Windows device runs Jarvis"',
    "  Pop $0",
    '  ${NSD_CreateRadioButton} 0 30u 100% 16u "Full Node — UI, voice, and local execution"',
    "  Pop $FullRadio",
    '  ${NSD_CreateRadioButton} 0 52u 100% 16u "Controller Node — UI and voice, no local execution"',
    "  Pop $ControllerRadio",
    '  ${NSD_CreateRadioButton} 0 74u 100% 16u "Headless Node — background execution, no UI or voice"',
    "  Pop $HeadlessRadio",
    '  ${If} $NodeMode == "controller"',
    "    ${NSD_Check} $ControllerRadio",
    '  ${ElseIf} $NodeMode == "headless"',
    "    ${NSD_Check} $HeadlessRadio",
    "  ${Else}",
    "    ${NSD_Check} $FullRadio",
    "  ${EndIf}",
    "  ${NSD_OnClick} $FullRadio ModeFullClicked",
    "  ${NSD_OnClick} $ControllerRadio ModeControllerClicked",
    "  ${NSD_OnClick} $HeadlessRadio ModeHeadlessClicked",
    "  nsDialogs::Show",
    "FunctionEnd",
    "Function ModeFullClicked",
    '  StrCpy $NodeMode "full"',
    "FunctionEnd",
    "Function ModeControllerClicked",
    '  StrCpy $NodeMode "controller"',
    "FunctionEnd",
    "Function ModeHeadlessClicked",
    '  StrCpy $NodeMode "headless"',
    "FunctionEnd",
    "Function ModePageLeave",
    '  StrCmp $NodeMode "full" 0 +3',
    '  StrCpy $0 "full"',
    "  Goto mode_valid",
    '  StrCmp $NodeMode "controller" 0 +3',
    '  StrCpy $0 "controller"',
    "  Goto mode_valid",
    '  StrCmp $NodeMode "headless" 0 mode_invalid',
    '  StrCpy $0 "headless"',
    "mode_valid:",
    "  StrCpy $NodeMode $0",
    "  Return",
    "mode_invalid:",
    '  MessageBox MB_ICONSTOP "Choose Full, Controller, or Headless Node."',
    "  Abort",
    "FunctionEnd",
    "",
    'Section "Reset old mode" SEC_RESET',
    "  ; Payloads are extracted under .incoming first; active payloads survive an extraction failure.",
    "  IfSilent apps_close apps_prompt",
    "apps_prompt:",
    '  MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL "Close Jarvis and Jarvis Companion before continuing. The installer will request both applications to exit." IDOK apps_close IDCANCEL apps_abort',
    "apps_abort:",
    "  Abort",
    "apps_close:",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\taskkill.exe /IM "Jarvis.exe" /T')}`,
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\taskkill.exe /IM "Jarvis Companion.exe" /T')}`,
    '  RMDir /r "$INSTDIR\\.incoming"',
    '  CreateDirectory "$PROFILE\\.jarvis\\runtime"',
    '  ReadINIStr $ExistingMode "$PROFILE\\.jarvis\\config\\preset.ini" Jarvis Preset',
    '  StrCmp $ExistingMode "headless" 0 previous_mode_checked',
    '  StrCpy $PreviousHeadless "1"',
    "previous_mode_checked:",
    '  FileOpen $0 "$PROFILE\\.jarvis\\runtime\\windows-stop.marker" w',
    "  FileClose $0",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /End /TN "Jarvis Headless Node"')}`,
    "  Sleep 2000",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /Delete /TN "Jarvis Headless Node" /F')}`,
    "SectionEnd",
    "",
    'Section "Desktop payload" SEC_DESKTOP',
    '  StrCmp $NodeMode "headless" desktop_done',
    `  SetOutPath "$INSTDIR\\.incoming\\desktop"`,
    `  File /r ${nsiQuote(desktopStage + "\\*")}`,
    "desktop_done:",
    "SectionEnd",
    "",
    'Section "Companion payload" SEC_COMPANION',
    '  StrCmp $NodeMode "headless" companion_done',
    `  SetOutPath "$INSTDIR\\.incoming\\companion"`,
    `  File /r ${nsiQuote(companionStage + "\\*")}`,
    "companion_done:",
    "SectionEnd",
    "",
    'Section "Windows runtime payload" SEC_RUNTIME',
    '  StrCmp $NodeMode "headless" runtime_extract',
    "  Goto runtime_done",
    "runtime_extract:",
    '  SetOutPath "$INSTDIR\\.incoming\\runtime-win"',
    `  File /r ${nsiQuote(runtimeStage + "\\*")}`,
    "runtime_done:",
    "SectionEnd",
    "",
    'Section "Persist node mode" SEC_STATE',
    "  ; Commit the fully extracted payload set only after all File operations succeeded.",
    '  SetOutPath "$INSTDIR\\.incoming"',
    `  File /oname=payload-manifest.json ${nsiQuote(`${windowsPath(input.stageRoot)}\\manifest.json`)}`,
    "  Call ValidateStagedPayload",
    "  ; Move the old payload aside only after validation. If any incoming rename fails,",
    "  ; RestorePreviousPayload puts that complete old payload back before aborting.",
    '  RMDir /r "$INSTDIR\\.previous"',
    '  CreateDirectory "$INSTDIR\\.previous"',
    '  StrCpy $PreviousManifestMoved "0"',
    '  StrCpy $PreviousDesktopMoved "0"',
    '  StrCpy $PreviousCompanionMoved "0"',
    '  StrCpy $PreviousRuntimeMoved "0"',
    '  StrCpy $NewManifestMoved "0"',
    '  StrCpy $NewDesktopMoved "0"',
    '  StrCpy $NewCompanionMoved "0"',
    '  StrCpy $NewRuntimeMoved "0"',
    "  ; Stage every existing payload, not only the selected mode. This removes",
    "  ; stale UI/voice files on a Full/Controller -> Headless upgrade and stale",
    "  ; runtime files on the reverse transition.",
    '  IfFileExists "$INSTDIR\\payload-manifest.json" 0 backup_manifest_done',
    '  Rename "$INSTDIR\\payload-manifest.json" "$INSTDIR\\.previous\\payload-manifest.json"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $PreviousManifestMoved "1"',
    "backup_manifest_done:",
    '  IfFileExists "$INSTDIR\\desktop" 0 backup_desktop_done',
    '  Rename "$INSTDIR\\desktop" "$INSTDIR\\.previous\\desktop"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $PreviousDesktopMoved "1"',
    "backup_desktop_done:",
    '  IfFileExists "$INSTDIR\\companion" 0 backup_companion_done',
    '  Rename "$INSTDIR\\companion" "$INSTDIR\\.previous\\companion"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $PreviousCompanionMoved "1"',
    "backup_companion_done:",
    '  IfFileExists "$INSTDIR\\runtime-win" 0 commit_selected_payload',
    '  Rename "$INSTDIR\\runtime-win" "$INSTDIR\\.previous\\runtime-win"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $PreviousRuntimeMoved "1"',
    "commit_selected_payload:",
    '  StrCmp $NodeMode "headless" commit_runtime commit_gui',
    "commit_runtime:",
    '  Rename "$INSTDIR\\.incoming\\runtime-win" "$INSTDIR\\runtime-win"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $NewRuntimeMoved "1"',
    "  Goto payload_committed",
    "commit_gui:",
    '  Rename "$INSTDIR\\.incoming\\desktop" "$INSTDIR\\desktop"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $NewDesktopMoved "1"',
    '  Rename "$INSTDIR\\.incoming\\companion" "$INSTDIR\\companion"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $NewCompanionMoved "1"',
    "payload_committed:",
    '  Rename "$INSTDIR\\.incoming\\payload-manifest.json" "$INSTDIR\\payload-manifest.json"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $NewManifestMoved "1"',
    '  RMDir /r "$INSTDIR\\.incoming"',
    '  RMDir /r "$INSTDIR\\.previous"',
    '  CreateDirectory "$PROFILE\\.jarvis\\config"',
    '  CreateDirectory "$PROFILE\\.jarvis\\runtime"',
    '  WriteINIStr "$PROFILE\\.jarvis\\config\\preset.ini" Jarvis Preset $NodeMode',
    '  FileOpen $0 "$PROFILE\\.jarvis\\config\\node-preset.json" w',
    // The NSIS string delimiters are the ordinary quotes immediately around
    // the JSON object. `$\\"` is only used for JSON's inner quotes; using it
    // around the whole object would persist an invalid quoted JSON string.
    '  FileWrite $0 "{$\\"product$\\":$\\"Jarvis$\\",$\\"preset$\\":$\\"$NodeMode$\\",$\\"nodeType$\\":$\\"$NodeMode$\\"}$\\r$\\n"',
    "  FileClose $0",
    '  WriteRegStr HKCU "Software\\Jarvis" "InstallLocation" "$INSTDIR"',
    '  WriteRegStr HKCU "Software\\Jarvis" "Preset" "$NodeMode"',
    '  WriteUninstaller "$INSTDIR\\Uninstall Jarvis.exe"',
    '  StrCmp $NodeMode "headless" 0 state_gui',
    '  FileOpen $0 "$PROFILE\\.jarvis\\runtime\\windows-stop.marker" w',
    "  FileClose $0",
    '  Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"',
    `  nsExec::ExecToLog ${nsiQuote(renderWindowsTaskCreateCommand("$INSTDIR\\runtime-win\\jarvis-node-launcher.cmd"))}`,
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /Run /TN "Jarvis Headless Node"')}`,
    "  Goto state_done",
    "state_gui:",
    `  CreateShortCut "$DESKTOP\\Jarvis.lnk" "$INSTDIR\\desktop\\Jarvis.exe"`,
    `  CreateShortCut "$DESKTOP\\Jarvis Companion.lnk" "$INSTDIR\\companion\\Jarvis Companion.exe"`,
    "  Goto state_done",
    "staged_commit_failed:",
    "  Call RestorePreviousPayload",
    "state_done:",
    "SectionEnd",
    "",
    "Function ValidateStagedPayload",
    "  ; Never remove the active payload until the selected incoming set and manifest are present.",
    '  IfFileExists "$INSTDIR\\.incoming\\payload-manifest.json" +2 0',
    "  Goto staged_payload_invalid",
    '  StrCmp $NodeMode "headless" 0 staged_payload_gui',
    '  IfFileExists "$INSTDIR\\.incoming\\runtime-win\\jarvis-payload-complete.txt" staged_payload_valid 0',
    "  Goto staged_payload_invalid",
    "staged_payload_gui:",
    '  IfFileExists "$INSTDIR\\.incoming\\desktop\\jarvis-payload-complete.txt" 0 staged_payload_invalid',
    '  IfFileExists "$INSTDIR\\.incoming\\companion\\jarvis-payload-complete.txt" staged_payload_valid staged_payload_invalid',
    "staged_payload_valid:",
    "  Return",
    "staged_payload_invalid:",
    '  RMDir /r "$INSTDIR\\.incoming"',
    '  Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"',
    '  StrCmp $PreviousHeadless "1" 0 staged_payload_invalid_message',
    `  nsExec::ExecToLog ${nsiQuote(renderWindowsTaskCreateCommand("$INSTDIR\\runtime-win\\jarvis-node-launcher.cmd"))}`,
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /Run /TN "Jarvis Headless Node"')}`,
    "staged_payload_invalid_message:",
    '  MessageBox MB_ICONSTOP "Jarvis could not validate the staged payload. Your existing installation was left in place."',
    "  Abort",
    "FunctionEnd",
    "",
    "Function RestorePreviousPayload",
    '  StrCmp $NewDesktopMoved "1" 0 restore_new_companion',
    '  RMDir /r "$INSTDIR\\desktop"',
    "restore_new_companion:",
    '  StrCmp $NewCompanionMoved "1" 0 restore_new_runtime',
    '  RMDir /r "$INSTDIR\\companion"',
    "restore_new_runtime:",
    '  StrCmp $NewRuntimeMoved "1" 0 restore_new_manifest',
    '  RMDir /r "$INSTDIR\\runtime-win"',
    "restore_new_manifest:",
    '  StrCmp $NewManifestMoved "1" 0 restore_desktop',
    '  Delete "$INSTDIR\\payload-manifest.json"',
    "restore_desktop:",
    '  StrCmp $PreviousDesktopMoved "1" 0 restore_companion',
    '  IfFileExists "$INSTDIR\\.previous\\desktop" 0 restore_companion',
    '  Rename "$INSTDIR\\.previous\\desktop" "$INSTDIR\\desktop"',
    "restore_companion:",
    '  StrCmp $PreviousCompanionMoved "1" 0 restore_runtime',
    '  IfFileExists "$INSTDIR\\.previous\\companion" 0 restore_runtime',
    '  Rename "$INSTDIR\\.previous\\companion" "$INSTDIR\\companion"',
    "restore_runtime:",
    '  StrCmp $PreviousRuntimeMoved "1" 0 restore_manifest',
    '  IfFileExists "$INSTDIR\\.previous\\runtime-win" 0 restore_manifest',
    '  Rename "$INSTDIR\\.previous\\runtime-win" "$INSTDIR\\runtime-win"',
    "restore_manifest:",
    '  StrCmp $PreviousManifestMoved "1" 0 restore_task',
    '  IfFileExists "$INSTDIR\\.previous\\payload-manifest.json" 0 restore_task',
    '  Rename "$INSTDIR\\.previous\\payload-manifest.json" "$INSTDIR\\payload-manifest.json"',
    "restore_task:",
    '  StrCmp $PreviousHeadless "1" 0 restore_manifest_done',
    '  Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"',
    `  nsExec::ExecToLog ${nsiQuote(renderWindowsTaskCreateCommand("$INSTDIR\\runtime-win\\jarvis-node-launcher.cmd"))}`,
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /Run /TN "Jarvis Headless Node"')}`,
    "restore_manifest_done:",
    '  RMDir /r "$INSTDIR\\.previous"',
    '  RMDir /r "$INSTDIR\\.incoming"',
    '  MessageBox MB_ICONSTOP "Jarvis could not commit the staged payload. Your existing installation was restored."',
    "  Abort",
    "FunctionEnd",
    "",
    'Section "Uninstall"',
    '  CreateDirectory "$PROFILE\\.jarvis\\runtime"',
    '  FileOpen $0 "$PROFILE\\.jarvis\\runtime\\windows-stop.marker" w',
    "  FileClose $0",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /End /TN "Jarvis Headless Node"')}`,
    "  Sleep 2000",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /Delete /TN "Jarvis Headless Node" /F')}`,
    '  Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"',
    '  Delete "$DESKTOP\\Jarvis.lnk"',
    '  Delete "$DESKTOP\\Jarvis Companion.lnk"',
    '  DeleteRegKey HKCU "Software\\Jarvis"',
    '  RMDir /r "$INSTDIR"',
    "  ; Deliberately preserve $PROFILE\\.jarvis: projects, providers, reports, and credentials.",
    "SectionEnd",
    "",
  ].join("\r\n");
}

export async function writeWindowsSetupManifest(
  path: string,
  manifest: WindowsSetupManifest,
): Promise<void> {
  await NodeFSP.writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function writeWindowsSetupProvenance(
  path: string,
  provenance: WindowsSetupProvenance,
): Promise<void> {
  await NodeFSP.writeFile(path, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
}
