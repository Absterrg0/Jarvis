#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const targetArgIndex = process.argv.indexOf("--target");
const targetName =
  targetArgIndex >= 0 ? process.argv[targetArgIndex + 1] : `${os.platform()}-${os.arch()}`;
const targets = {
  "darwin-arm64": { platform: "darwin", arch: "arm64", rustTarget: "aarch64-apple-darwin" },
  "darwin-x64": { platform: "darwin", arch: "x64", rustTarget: "x86_64-apple-darwin" },
  "linux-arm64": { platform: "linux", arch: "arm64", rustTarget: "aarch64-unknown-linux-gnu" },
  "linux-x64": { platform: "linux", arch: "x64", rustTarget: "x86_64-unknown-linux-gnu" },
  "win32-arm64": { platform: "win32", arch: "arm64", rustTarget: "aarch64-pc-windows-msvc" },
  "win32-x64": { platform: "win32", arch: "x64", rustTarget: "x86_64-pc-windows-msvc" },
};
const target = targets[targetName];
if (target === undefined) throw new Error(`Unsupported native microphone target: ${targetName}`);
if (os.platform() !== target.platform || os.arch() !== target.arch) {
  throw new Error(
    `Refusing cross-architecture native microphone build: runner is ${os.platform()}-${os.arch()}, target is ${targetName}.`,
  );
}
const neonBinaryPath = path.join(packageRoot, "index.node");
await rm(neonBinaryPath, { force: true });

const cargoArgs = [
  "build",
  "--locked",
  "--release",
  "--target",
  target.rustTarget,
  "--message-format=json-render-diagnostics",
];
const cargo = await execFileAsync("cargo", cargoArgs, {
  cwd: packageRoot,
  maxBuffer: 20 * 1024 * 1024,
});
await new Promise((resolve, reject) => {
  const neon = spawn("pnpm", ["exec", "neon", "dist"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      npm_package_name: "@t3tools/jarvis-native-microphone",
      npm_package_version: "0.1.1",
    },
    stdio: ["pipe", "inherit", "inherit"],
  });
  neon.once("error", reject);
  neon.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`neon dist exited with status ${code ?? "unknown"}.`));
  });
  neon.stdin.end(cargo.stdout);
});

const binaryPath = path.join(packageRoot, "bin", targetName, "index.node");
if (existsSync(neonBinaryPath)) {
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await copyFile(neonBinaryPath, binaryPath);
  await rm(neonBinaryPath);
}
if (!existsSync(binaryPath) || !lstatSync(binaryPath).isFile()) {
  throw new Error(`Native microphone build did not stage the exact binary ${binaryPath}.`);
}
for (const candidate of Object.keys(targets)) {
  if (candidate !== targetName) {
    const wrongBinary = path.join(packageRoot, "bin", candidate, "index.node");
    if (existsSync(wrongBinary))
      throw new Error(`Build staged an unexpected architecture: ${wrongBinary}`);
  }
}
console.log(`Built Jarvis native microphone ${targetName}: ${binaryPath}`);
