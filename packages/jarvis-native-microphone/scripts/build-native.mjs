#!/usr/bin/env node
// oxlint-disable t3code/no-global-process-runtime -- Standalone native build script owns the host process boundary.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const require = NodeModule.createRequire(import.meta.url);
const packageRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
const targetArgIndex = process.argv.indexOf("--target");
const targetName =
  targetArgIndex >= 0 ? process.argv[targetArgIndex + 1] : `${NodeOS.platform()}-${NodeOS.arch()}`;
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
if (NodeOS.platform() !== target.platform || NodeOS.arch() !== target.arch) {
  throw new Error(
    `Refusing cross-architecture native microphone build: runner is ${NodeOS.platform()}-${NodeOS.arch()}, target is ${targetName}.`,
  );
}
const neonBinaryPath = NodePath.join(packageRoot, "index.node");
await NodeFSP.rm(neonBinaryPath, { force: true });

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
const neonCliPath = require.resolve("@neon-rs/cli");
await new Promise((resolve, reject) => {
  const neon = NodeChildProcess.spawn(process.execPath, [neonCliPath, "dist"], {
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

const binaryPath = NodePath.join(packageRoot, "bin", targetName, "index.node");
if (NodeFS.existsSync(neonBinaryPath)) {
  await NodeFSP.mkdir(NodePath.dirname(binaryPath), { recursive: true });
  await NodeFSP.copyFile(neonBinaryPath, binaryPath);
  await NodeFSP.rm(neonBinaryPath);
}
if (!NodeFS.existsSync(binaryPath) || !NodeFS.lstatSync(binaryPath).isFile()) {
  throw new Error(`Native microphone build did not stage the exact binary ${binaryPath}.`);
}
for (const candidate of Object.keys(targets)) {
  if (candidate !== targetName) {
    const wrongBinary = NodePath.join(packageRoot, "bin", candidate, "index.node");
    if (NodeFS.existsSync(wrongBinary))
      throw new Error(`Build staged an unexpected architecture: ${wrongBinary}`);
  }
}
console.log(`Built Jarvis native microphone ${targetName}: ${binaryPath}`);
