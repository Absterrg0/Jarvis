#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const FileSystem = NodeFSP;
const Path = NodePath;

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
  await FileSystem.cp(deployDir, stagedRuntimeDir, {
    recursive: true,
    force: true,
    dereference: false,
    filter: async (source) => {
      const stat = await FileSystem.lstat(source);
      if (!stat.isSymbolicLink()) return true;
      await validateWindowsRuntimeLink(deployDir, source);
      return false;
    },
  });
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
