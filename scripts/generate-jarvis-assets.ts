#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This small raster export CLI is intentionally a synchronous ImageMagick boundary.

/**
 * Render the generated Jarvis master into every existing Jarvis asset path.
 *
 * The checked-in 1254px master is the source of truth. `--check` renders into
 * a temporary directory and compares bytes, so
 * CI can catch a stale platform or web asset without mutating the checkout.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const source = NodePath.join(repoRoot, "assets/jarvis/jarvis-master.png");
const rasterOutputs = [
  ["assets/jarvis/jarvis-ios-1024.png", 1024],
  ["assets/jarvis/jarvis-macos-1024.png", 1024],
  ["assets/jarvis/jarvis-universal-1024.png", 1024],
  ["assets/jarvis/jarvis-web-favicon-16x16.png", 16],
  ["assets/jarvis/jarvis-web-favicon-32x32.png", 32],
  ["assets/jarvis/jarvis-web-apple-touch-180.png", 180],
  ["apps/web/public/jarvis-mark.png", 32],
] as const;

const icoOutputs = [
  "assets/jarvis/jarvis-web-favicon.ico",
  "assets/jarvis/jarvis-windows.ico",
] as const;

function runMagick(args: ReadonlyArray<string>): void {
  NodeChildProcess.execFileSync("magick", args, { cwd: repoRoot, stdio: "pipe" });
}

function renderPng(output: string, size: number): void {
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  runMagick([
    "-background",
    "none",
    "-density",
    "96",
    source,
    "-resize",
    `${size}x${size}`,
    "-depth",
    "8",
    "-strip",
    "-define",
    "png:compression-level=9",
    `PNG32:${output}`,
  ]);
}

function renderIco(output: string): void {
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  runMagick([
    "-background",
    "none",
    "-density",
    "96",
    source,
    "-define",
    "icon:auto-resize=16,24,32,48,64,128,256",
    "-strip",
    output,
  ]);
}

function generate(destinationRoot: string): void {
  for (const [relativePath, size] of rasterOutputs) {
    renderPng(NodePath.join(destinationRoot, relativePath), size);
  }
  for (const relativePath of icoOutputs) {
    renderIco(NodePath.join(destinationRoot, relativePath));
  }
}

function assertSource(): void {
  if (!NodeFS.existsSync(source)) {
    throw new Error(`Missing Jarvis generated master: ${NodePath.relative(repoRoot, source)}`);
  }
}

function check(): number {
  const stagingRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jarvis-assets-"));
  try {
    generate(stagingRoot);
    const stale = [...rasterOutputs.map(([path]) => path), ...icoOutputs].filter((path) => {
      const expected = NodePath.join(repoRoot, path);
      const generated = NodePath.join(stagingRoot, path);
      return (
        !NodeFS.existsSync(expected) ||
        !NodeFS.readFileSync(expected).equals(NodeFS.readFileSync(generated))
      );
    });
    if (stale.length > 0) {
      console.error(`Jarvis assets are stale:\n${stale.map((path) => `- ${path}`).join("\n")}`);
      return 1;
    }
    console.log("Jarvis assets are current.");
    return 0;
  } finally {
    NodeFS.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

assertSource();
if (process.argv.includes("--check")) {
  process.exitCode = check();
} else {
  generate(repoRoot);
  console.log(
    `Generated ${rasterOutputs.length + icoOutputs.length} Jarvis assets from ${NodePath.relative(repoRoot, source)}.`,
  );
}
