#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off

import { copyDeployedPackage } from "./package-headless-node.ts";

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
  await copyDeployedPackage(valueFor(args, "--source"), valueFor(args, "--target"));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
