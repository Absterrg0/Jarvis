#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off

// Builds the single outer Windows setup. Child apps are inputs only: this
// script never invokes their publishers or gives them an updater authority.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { getPath7za } from "app-builder-lib/out/toolsets/7zip.js";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

import {
  assertWindowsSetupArch,
  assertWindowsSetupSourceCommit,
  createWindowsSetupProvenance,
  createWindowsSetupManifest,
  renderWindowsSetupNsi,
  renderWindowsNodeLauncherCmd,
  renderWindowsNodeStopPs1,
  renderWindowsNodeSupervisorMjs,
  renderWindowsOwnedProcessStopPs1,
  windowsSetupAliasName,
  windowsSetupArtifactName,
  windowsSetupManifestName,
  windowsSetupProvenanceName,
  writeWindowsSetupManifest,
  writeWindowsSetupProvenance,
  type WindowsSetupArch,
} from "./windows-setup.ts";

interface CliInput {
  readonly version: string;
  readonly arch: WindowsSetupArch;
  readonly desktopDir: string;
  readonly companionDir: string;
  readonly runtimeDir: string;
  readonly outputDir: string;
  readonly sourceCommit: string | undefined;
  readonly makensis: string | undefined;
  readonly renderOnly: boolean;
}

export const WINDOWS_SETUP_ARCHIVE_ARGS = [
  "a",
  "-bd",
  "-y",
  "-bb0",
  "-mx=7",
  "-ms=on",
  "-mf=BCJ",
  "-mtc=off",
  "-mtm=off",
  "-mta=off",
] as const;

/** NSIS uses the BOM to decode the generated source as UTF-8 on Windows. */
export function encodeWindowsSetupNsi(source: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, "utf8")]);
}

/** Resolve the canonical production Windows icon used by desktop packaging. */
export function windowsSetupIconPath(repoRoot: string): string {
  return NodePath.resolve(repoRoot, BRAND_ASSET_PATHS.productionWindowsIconIco);
}

export async function createWindowsSetupArchive(
  sevenZipPath: string,
  archivePath: string,
  payloadDirectory: string,
): Promise<void> {
  await NodeFSP.rm(archivePath, { force: true });
  const result = NodeChildProcess.spawnSync(
    sevenZipPath,
    [...WINDOWS_SETUP_ARCHIVE_ARGS, archivePath, "."],
    {
      cwd: payloadDirectory,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const output = [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .trim();
  if (result.error || result.status !== 0) {
    const status = result.status === null ? "unknown" : String(result.status);
    const cause = result.error ? `: ${result.error.message}` : "";
    throw new Error(
      `7zz failed to create ${archivePath} (exit code ${status})${cause}${output ? `\n${output}` : ""}`,
    );
  }
}

export async function createWindowsSetupArchives(stageRoot: string): Promise<void> {
  const sevenZipPath = await getPath7za();
  for (const name of ["desktop", "companion", "runtime-win"]) {
    await createWindowsSetupArchive(
      sevenZipPath,
      NodePath.join(stageRoot, `${name}.7z`),
      NodePath.join(stageRoot, name),
    );
  }
}

export async function resolveWindowsSevenZipPath(): Promise<string> {
  return getPath7za();
}

function usage(): never {
  throw new Error(
    "Usage: node scripts/build-windows-setup.ts --version <semver> --arch <x64|arm64> --desktop-dir <dir> --companion-dir <dir> --runtime-dir <dir> --output-dir <dir> [--source-commit <sha>] [--makensis <path>] [--render-only]",
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
    sourceCommit: values.get("source-commit"),
    makensis: values.get("makensis"),
    renderOnly,
  };
}

async function resolveSourceCommit(explicit: string | undefined): Promise<string> {
  if (explicit) {
    assertWindowsSetupSourceCommit(explicit);
    return explicit;
  }
  const result = NodeChildProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (result.error) throw new Error(`Could not resolve source commit: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Could not resolve source commit (exit code ${result.status ?? "unknown"}).`);
  }
  const value = result.stdout.trim();
  assertWindowsSetupSourceCommit(value);
  return value;
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stat = await NodeFSP.stat(path).catch(() => undefined);
  if (!stat?.isDirectory())
    throw new Error(`${label} does not exist or is not a directory: ${path}`);
}

export interface MakensisSearchEnvironment {
  readonly makensis?: string | undefined;
  readonly electronBuilderCache?: string | undefined;
  readonly localAppData?: string | undefined;
  readonly comSpec?: string | undefined;
}

export async function makensisCacheCandidates(
  electronBuilderCache?: string,
  localAppData?: string,
): Promise<string[]> {
  const cacheRoots = [
    electronBuilderCache,
    localAppData ? NodePath.join(localAppData, "electron-builder", "Cache") : undefined,
  ].filter((root): root is string => Boolean(root));
  const candidates: string[] = [];
  for (const cacheRoot of cacheRoots) {
    const nsisRoot = NodePath.join(cacheRoot, "nsis-3.0.4.1");
    const entries = await NodeFSP.readdir(nsisRoot, { withFileTypes: true }).catch(() => []);
    const hashedDirectories = entries
      .filter((entry) => entry.isDirectory() && /^nsis-3\.0\.4\.1-.+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    candidates.push(
      ...hashedDirectories.map((directory) =>
        NodePath.join(nsisRoot, directory, "Bin", "makensis.exe"),
      ),
      NodePath.join(nsisRoot, "Bin", "makensis.exe"),
      NodePath.join(nsisRoot, "makensis.exe"),
    );
  }
  return [...new Set(candidates)];
}

export async function findMakensis(
  explicit: string | undefined,
  environment: MakensisSearchEnvironment = {
    makensis: process.env.MAKENSIS,
    electronBuilderCache: process.env.ELECTRON_BUILDER_CACHE,
    localAppData: process.env.LOCALAPPDATA,
    comSpec: process.env.ComSpec,
  },
): Promise<string | undefined> {
  if (explicit) return explicit;
  const candidates = [
    environment.makensis,
    ...(await makensisCacheCandidates(environment.electronBuilderCache, environment.localAppData)),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if ((await NodeFSP.stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  const probe = NodeChildProcess.spawnSync(
    environment.comSpec ? "where.exe" : "which",
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

function packageNameFromJson(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("name" in value)) return undefined;
  const name = value.name;
  return typeof name === "string" ? name : undefined;
}

async function packageNameAt(directory: string): Promise<string | undefined> {
  const packageJson = NodePath.join(directory, "package.json");
  const stat = await NodeFSP.stat(packageJson).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  try {
    return packageNameFromJson(JSON.parse(await NodeFSP.readFile(packageJson, "utf8")));
  } catch (error) {
    throw new Error(
      `Could not parse deployed package manifest ${packageJson}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function removeSourceMaps(directory: string): Promise<void> {
  const stat = await NodeFSP.stat(directory).catch(() => undefined);
  if (!stat?.isDirectory()) return;
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeSourceMaps(path);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".map")) {
      await NodeFSP.rm(path, { force: true });
    }
  }
}

/** Remove client/source-only packages from the standalone runtime payload. */
async function pruneRuntimePayload(source: string): Promise<void> {
  const root = NodePath.resolve(source);

  async function visit(directory: string): Promise<void> {
    const packageName = await packageNameAt(directory);
    if (packageName === "@t3tools/web") {
      if (NodePath.resolve(directory) === root) {
        throw new Error("The standalone runtime root cannot be the @t3tools/web package.");
      }
      await NodeFSP.rm(directory, { recursive: true, force: true });
      return;
    }
    if (packageName === "t3") {
      await NodeFSP.rm(NodePath.join(directory, "src"), { recursive: true, force: true });
      await NodeFSP.rm(NodePath.join(directory, "dist", "client"), {
        recursive: true,
        force: true,
      });
      await removeSourceMaps(NodePath.join(directory, "dist"));
    }

    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(NodePath.join(directory, entry.name));
    }
  }

  await visit(root);
}

async function copyRuntimePayload(source: string, target: string): Promise<void> {
  await copyPayload(source, target);
  await pruneRuntimePayload(target);
  // The scheduled task intentionally launches a stable wrapper beside the
  // runtime. Generate it here so every runtime producer gets the same
  // restart/stop behavior; the CI workflow only has to provide node.exe and
  // the bundled dist/bin.mjs entrypoint.
  await NodeFSP.writeFile(
    NodePath.join(target, "jarvis-node-launcher.cmd"),
    renderWindowsNodeLauncherCmd(),
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(target, "jarvis-node-supervisor.mjs"),
    renderWindowsNodeSupervisorMjs(),
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(target, "jarvis-node-stop.ps1"),
    renderWindowsNodeStopPs1(),
    "utf8",
  );
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone CLI needs the host platform for makensis flags.
function makensisVerbosityFlag(platform: string = NodeOS.platform()): "/V2" | "-V2" {
  return platform === "win32" ? "/V2" : "-V2";
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const sourceCommit = await resolveSourceCommit(input.sourceCommit);
  await Promise.all([
    assertDirectory(input.desktopDir, "desktop payload"),
    assertDirectory(input.companionDir, "companion payload"),
    assertDirectory(input.runtimeDir, "Windows runtime payload"),
  ]);

  const iconPath = windowsSetupIconPath(repoRoot);
  if (!(await NodeFSP.stat(iconPath).catch(() => undefined))?.isFile()) {
    throw new Error(`Canonical production Windows icon is missing: ${iconPath}`);
  }

  const outputDir = NodePath.resolve(input.outputDir);
  await NodeFSP.mkdir(outputDir, { recursive: true });
  const stageRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-setup-"));
  try {
    await Promise.all([
      copyPayload(input.desktopDir, NodePath.join(stageRoot, "desktop")),
      copyPayload(input.companionDir, NodePath.join(stageRoot, "companion")),
      copyRuntimePayload(input.runtimeDir, NodePath.join(stageRoot, "runtime-win")),
    ]);
    await NodeFSP.writeFile(
      NodePath.join(stageRoot, "jarvis-owned-process-stop.ps1"),
      renderWindowsOwnedProcessStopPs1(),
      "utf8",
    );
    await NodeFSP.copyFile(iconPath, NodePath.join(stageRoot, "jarvis.ico"));
    await createWindowsSetupArchives(stageRoot);
    const manifest = await createWindowsSetupManifest({
      version: input.version,
      arch: input.arch,
      sourceCommit,
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
    const sevenZipPath = await resolveWindowsSevenZipPath();
    const nsiPath = NodePath.join(stageRoot, "Jarvis-Setup.nsi");
    await NodeFSP.writeFile(
      nsiPath,
      encodeWindowsSetupNsi(
        renderWindowsSetupNsi({
          version: input.version,
          arch: input.arch,
          outputPath: artifactPath,
          stageRoot,
          sevenZipPath,
          iconPath: NodePath.join(stageRoot, "jarvis.ico"),
        }),
      ),
    );
    await NodeFSP.copyFile(
      manifestPath,
      NodePath.join(outputDir, windowsSetupManifestName(input.version, input.arch)),
    );
    if (input.renderOnly) {
      console.log(`[windows-setup] Rendered ${nsiPath}`);
      return;
    }
    const compiler = await findMakensis(input.makensis);
    if (!compiler) {
      throw new Error("makensis.exe was not found. Run this build on Windows or pass --makensis.");
    }
    const result = NodeChildProcess.spawnSync(compiler, [makensisVerbosityFlag(), nsiPath], {
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
    const manifestName = windowsSetupManifestName(input.version, input.arch);
    const manifestSha256 = await NodeFSP.readFile(NodePath.join(outputDir, manifestName)).then(
      (bytes) =>
        import("node:crypto").then(({ createHash }) =>
          createHash("sha256").update(bytes).digest("hex"),
        ),
    );
    await NodeFSP.writeFile(
      NodePath.join(outputDir, `${windowsSetupArtifactName(input.version, input.arch)}.sha256`),
      `${digest}  ${windowsSetupArtifactName(input.version, input.arch)}\n`,
    );
    await writeWindowsSetupProvenance(
      NodePath.join(outputDir, windowsSetupProvenanceName(input.version, input.arch)),
      createWindowsSetupProvenance({
        artifactName: windowsSetupArtifactName(input.version, input.arch),
        artifactSha256: digest,
        aliasName: windowsSetupAliasName(),
        manifestName,
        manifestSha256,
        provenanceName: windowsSetupProvenanceName(input.version, input.arch),
        sourceCommit,
        version: input.version,
        arch: input.arch,
      }),
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

export { makensisVerbosityFlag, parseArgs, pruneRuntimePayload };
