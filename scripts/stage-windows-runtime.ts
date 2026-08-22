#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const FileSystem = NodeFSP;
const Path = NodePath;

const WINDOWS_RUNTIME_OS = "win32";
const WINDOWS_RUNTIME_CPU = "x64";
const ROOT_PNPM_METADATA = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml"]);
const ROOT_NODE_MODULES_METADATA = new Set([
  ".modules.yaml",
  ".package-map.json",
  ".pnpm-workspace-state-v1.json",
]);

type PackageManifest = {
  readonly os?: unknown;
  readonly cpu?: unknown;
};

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = Path.relative(Path.resolve(parent), Path.resolve(candidate));
  return (
    relative.length === 0 ||
    (relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  );
}

async function ensureDirectory(directoryPath: string, description: string): Promise<void> {
  const stat = await FileSystem.stat(directoryPath).catch(() => undefined);
  if (stat?.isDirectory() !== true) {
    throw new Error(`${description} was not found: ${directoryPath}`);
  }
}

async function validateWindowsRuntimeLink(sourceRoot: string, sourcePath: string): Promise<void> {
  const linkTarget = await FileSystem.readlink(sourcePath);
  const resolvedTarget = Path.resolve(Path.dirname(sourcePath), linkTarget);
  const relativeTarget = Path.relative(sourceRoot, resolvedTarget);
  const internalTarget =
    relativeTarget.length > 0 &&
    !relativeTarget.startsWith(`..${Path.sep}`) &&
    !Path.isAbsolute(relativeTarget);
  const targetStat = await FileSystem.stat(resolvedTarget).catch(() => undefined);
  const isBinShim = Path.basename(Path.dirname(sourcePath)) === ".bin";
  if (!isBinShim || !internalTarget || targetStat?.isFile() !== true) {
    throw new Error(
      `Windows runtime deploy contains an unsupported link: ${Path.relative(sourceRoot, sourcePath)}`,
    );
  }
}

function isNodeModulesPackageRoot(deployDir: string, sourcePath: string): boolean {
  const relativePath = Path.relative(Path.resolve(deployDir), Path.resolve(sourcePath));
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${Path.sep}`) ||
    Path.isAbsolute(relativePath)
  ) {
    return false;
  }
  const segments = relativePath.split(Path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== "node_modules") continue;
    const packageStart = index + 1;
    const packageName = segments[packageStart];
    if (packageName === undefined || packageName === ".bin" || packageName === ".pnpm") {
      continue;
    }
    const packageSegmentCount = packageName.startsWith("@") ? 2 : 1;
    if (packageStart + packageSegmentCount === segments.length) return true;
  }
  return false;
}

function constraintValues(value: unknown): string[] {
  if (typeof value === "string") return [value.toLowerCase()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.toLowerCase());
}

function satisfiesPlatformConstraint(value: unknown, target: string): boolean {
  const values = constraintValues(value);
  const positiveValues = values.filter((entry) => !entry.startsWith("!"));
  const negativeValues = values
    .filter((entry) => entry.startsWith("!"))
    .map((entry) => entry.slice(1));
  return (
    (positiveValues.length === 0 || positiveValues.includes(target)) &&
    !negativeValues.includes(target)
  );
}

function isWindowsX64Compatible(manifest: PackageManifest): boolean {
  return (
    satisfiesPlatformConstraint(manifest.os, WINDOWS_RUNTIME_OS) &&
    satisfiesPlatformConstraint(manifest.cpu, WINDOWS_RUNTIME_CPU)
  );
}

async function packageManifestAt(
  deployDir: string,
  sourcePath: string,
): Promise<PackageManifest | undefined> {
  if (!isNodeModulesPackageRoot(deployDir, sourcePath)) return undefined;
  const manifestPath = Path.join(sourcePath, "package.json");
  const manifestStat = await FileSystem.stat(manifestPath).catch(() => undefined);
  if (manifestStat?.isFile() !== true) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await FileSystem.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read package manifest for Windows runtime staging: ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  return parsed !== null && typeof parsed === "object" ? (parsed as PackageManifest) : undefined;
}

function isRootPnpmMetadata(deployDir: string, sourcePath: string): boolean {
  const relativePath = Path.relative(Path.resolve(deployDir), Path.resolve(sourcePath));
  return !relativePath.includes(Path.sep) && ROOT_PNPM_METADATA.has(relativePath);
}

function isRootNodeModulesMetadata(deployDir: string, sourcePath: string): boolean {
  const relativePath = Path.relative(
    Path.resolve(deployDir, "node_modules"),
    Path.resolve(sourcePath),
  );
  return !relativePath.includes(Path.sep) && ROOT_NODE_MODULES_METADATA.has(relativePath);
}

function isDebugArtifact(sourcePath: string): boolean {
  const lowerName = Path.basename(sourcePath).toLowerCase();
  return lowerName.endsWith(".pdb") || lowerName.endsWith(".map");
}

async function assertNoLinks(directory: string): Promise<void> {
  const entries = await FileSystem.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = Path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Windows runtime staging produced a link: ${entryPath}`);
      }
      if (entry.isDirectory()) await assertNoLinks(entryPath);
    }),
  );
}

/** Copy a Windows runtime without retaining pnpm's symlinked dependency layout. */
export async function copyWindowsRuntimePayload(
  deployDir: string,
  stagedRuntimeDir: string,
): Promise<void> {
  await ensureDirectory(deployDir, "deployed runtime directory");
  await FileSystem.mkdir(stagedRuntimeDir, { recursive: true });
  const virtualStore = Path.resolve(Path.join(deployDir, "node_modules", ".pnpm"));
  await FileSystem.cp(deployDir, stagedRuntimeDir, {
    recursive: true,
    force: true,
    dereference: false,
    filter: async (source) => {
      if (isPathInsideOrEqual(virtualStore, source)) return false;
      const stat = await FileSystem.lstat(source);
      if (
        (isRootPnpmMetadata(deployDir, source) || isRootNodeModulesMetadata(deployDir, source)) &&
        stat.isFile()
      ) {
        return false;
      }
      if (stat.isFile() && isDebugArtifact(source)) {
        return false;
      }
      if (stat.isDirectory()) {
        const manifest = await packageManifestAt(deployDir, source);
        if (manifest !== undefined && !isWindowsX64Compatible(manifest)) return false;
      }
      if (!stat.isSymbolicLink()) return true;
      await validateWindowsRuntimeLink(deployDir, source);
      return false;
    },
  });
  // Hoisted deploys keep a redundant virtual store beside the physical root
  // dependencies. The filter above omits that exact source subtree without
  // touching package-local stores elsewhere.
  await assertNoLinks(stagedRuntimeDir);
}

function usage(): never {
  throw new Error("Usage: node scripts/stage-windows-runtime.ts --source <dir> --target <dir>");
}

function valueFor(args: ReadonlyArray<string>, flag: string): string {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) usage();
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  await copyWindowsRuntimePayload(valueFor(args, "--source"), valueFor(args, "--target"));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
