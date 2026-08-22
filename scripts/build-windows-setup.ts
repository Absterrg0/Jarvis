#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off

// Builds the single outer Windows setup. Child apps are inputs only: this
// script never invokes their publishers or gives them an updater authority.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  assertWindowsSetupArch,
  createWindowsSetupManifest,
  renderWindowsSetupNsi,
  renderWindowsNodeLauncherCmd,
  windowsSetupAliasName,
  windowsSetupArtifactName,
  writeWindowsSetupManifest,
  type WindowsSetupArch,
} from "./windows-setup.ts";

interface CliInput {
  readonly version: string;
  readonly arch: WindowsSetupArch;
  readonly desktopDir: string;
  readonly companionDir: string;
  readonly runtimeDir: string;
  readonly outputDir: string;
  readonly makensis: string | undefined;
  readonly renderOnly: boolean;
}

function usage(): never {
  throw new Error(
    "Usage: node scripts/build-windows-setup.ts --version <semver> --arch <x64|arm64> --desktop-dir <dir> --companion-dir <dir> --runtime-dir <dir> --output-dir <dir> [--makensis <path>] [--render-only]",
  );
}

function parseArgs(argv: ReadonlyArray<string>): CliInput {
  const values = new Map<string, string>();
  let renderOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--render-only") {
      renderOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) usage();
    values.set(key.slice(2), value);
    index += 1;
  }
  const version = values.get("version");
  const arch = values.get("arch");
  const desktopDir = values.get("desktop-dir");
  const companionDir = values.get("companion-dir");
  const runtimeDir = values.get("runtime-dir");
  const outputDir = values.get("output-dir");
  if (!version || !arch || !desktopDir || !companionDir || !runtimeDir || !outputDir) usage();
  assertWindowsSetupArch(arch);
  return {
    version,
    arch,
    desktopDir,
    companionDir,
    runtimeDir,
    outputDir,
    makensis: values.get("makensis"),
    renderOnly,
  };
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stat = await NodeFSP.stat(path).catch(() => undefined);
  if (!stat?.isDirectory())
    throw new Error(`${label} does not exist or is not a directory: ${path}`);
}

async function findMakensis(explicit: string | undefined): Promise<string | undefined> {
  if (explicit) return explicit;
  const candidates = [
    process.env.MAKENSIS,
    process.env.ELECTRON_BUILDER_CACHE
      ? NodePath.join(process.env.ELECTRON_BUILDER_CACHE, "nsis", "nsis-3.0.4.1", "makensis.exe")
      : undefined,
    process.env.LOCALAPPDATA
      ? NodePath.join(
          process.env.LOCALAPPDATA,
          "electron-builder",
          "Cache",
          "nsis",
          "nsis-3.0.4.1",
          "makensis.exe",
        )
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if ((await NodeFSP.stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  const probe = NodeChildProcess.spawnSync(
    process.env.ComSpec ? "where.exe" : "which",
    ["makensis.exe"],
    {
      encoding: "utf8",
    },
  );
  const path = probe.status === 0 ? probe.stdout.trim().split(/\r?\n/u)[0] : "";
  return path || undefined;
}

async function copyPayload(source: string, target: string): Promise<void> {
  await NodeFSP.cp(source, target, { recursive: true, force: false, errorOnExist: true });
  // The marker is compiled into the outer installer and checked after NSIS
  // extraction, before the previous mode is removed.  This catches a partial
  // payload even when makensis itself reported a successful File operation.
  await NodeFSP.writeFile(NodePath.join(target, "jarvis-payload-complete.txt"), "Jarvis\n", "utf8");
}

async function copyRuntimePayload(source: string, target: string): Promise<void> {
  await copyPayload(source, target);
  // The scheduled task intentionally launches a stable wrapper beside the
  // runtime. Generate it here so every runtime producer gets the same
  // restart/stop behavior; the CI workflow only has to provide node.exe and
  // service-launcher.mjs.
  await NodeFSP.writeFile(
    NodePath.join(target, "jarvis-node-launcher.cmd"),
    renderWindowsNodeLauncherCmd(),
    "utf8",
  );
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  await Promise.all([
    assertDirectory(input.desktopDir, "desktop payload"),
    assertDirectory(input.companionDir, "companion payload"),
    assertDirectory(input.runtimeDir, "Windows runtime payload"),
  ]);

  const outputDir = NodePath.resolve(input.outputDir);
  await NodeFSP.mkdir(outputDir, { recursive: true });
  const stageRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-setup-"));
  try {
    await Promise.all([
      copyPayload(input.desktopDir, NodePath.join(stageRoot, "desktop")),
      copyPayload(input.companionDir, NodePath.join(stageRoot, "companion")),
      copyRuntimePayload(input.runtimeDir, NodePath.join(stageRoot, "runtime-win")),
    ]);
    const manifest = await createWindowsSetupManifest({
      version: input.version,
      arch: input.arch,
      payloadDirectories: {
        desktop: NodePath.join(stageRoot, "desktop"),
        companion: NodePath.join(stageRoot, "companion"),
        runtimeWin: NodePath.join(stageRoot, "runtime-win"),
      },
    });
    const manifestPath = NodePath.join(stageRoot, "manifest.json");
    await writeWindowsSetupManifest(manifestPath, manifest);
    const artifactPath = NodePath.join(
      outputDir,
      windowsSetupArtifactName(input.version, input.arch),
    );
    const nsiPath = NodePath.join(stageRoot, "Jarvis-Setup.nsi");
    await NodeFSP.writeFile(
      nsiPath,
      renderWindowsSetupNsi({
        version: input.version,
        arch: input.arch,
        outputPath: artifactPath,
        stageRoot,
      }),
      "utf8",
    );
    await NodeFSP.copyFile(
      manifestPath,
      NodePath.join(outputDir, `${artifactPath.split(NodePath.sep).pop()}.manifest.json`),
    );
    if (input.renderOnly) {
      console.log(`[windows-setup] Rendered ${nsiPath}`);
      return;
    }
    const compiler = await findMakensis(input.makensis);
    if (!compiler) {
      throw new Error("makensis.exe was not found. Run this build on Windows or pass --makensis.");
    }
    const result = NodeChildProcess.spawnSync(compiler, ["/V2", nsiPath], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new Error(`makensis.exe failed with exit code ${result.status ?? "unknown"}.`);
    await NodeFSP.copyFile(artifactPath, NodePath.join(outputDir, windowsSetupAliasName()));
    const digest = await NodeFSP.readFile(artifactPath).then((bytes) => {
      // The setup manifest already carries payload hashes; this sidecar makes
      // the outer signed artifact itself verifiable by release automation.
      return import("node:crypto").then(({ createHash }) =>
        createHash("sha256").update(bytes).digest("hex"),
      );
    });
    await NodeFSP.writeFile(
      NodePath.join(outputDir, `${windowsSetupArtifactName(input.version, input.arch)}.sha256`),
      `${digest}  ${windowsSetupArtifactName(input.version, input.arch)}\n`,
    );
    console.log(`[windows-setup] Wrote ${artifactPath} and ${windowsSetupAliasName()}`);
  } finally {
    await NodeFSP.rm(stageRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { parseArgs };
