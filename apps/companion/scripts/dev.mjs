import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const packageRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const outputDir = NodePath.resolve(packageRoot, "dist-electron");
const dataDir = NodePath.resolve(packageRoot, ".jarvis-companion-dev");
const diagnosticsPath = NodePath.resolve(dataDir, "diagnostics.jsonl");
const recordingDir = NodePath.resolve(dataDir, "recognition-recordings");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const electronArgs = [
  "exec",
  "electron",
  "dist-electron/main.cjs",
  "--jarvis-development",
  `--dev-data-dir=${dataDir}`,
  `--diagnostics=${diagnosticsPath}`,
  `--recording-dir=${recordingDir}`,
  ...process.argv.slice(2),
];

let electron;
let restartTimer;
let closing = false;

function startElectron() {
  if (closing || !NodeFS.existsSync(NodePath.resolve(outputDir, "main.cjs"))) return;
  electron = NodeChildProcess.spawn(pnpm, electronArgs, { cwd: packageRoot, stdio: "inherit" });
  electron.on("exit", () => {
    electron = undefined;
  });
}

function restartElectron() {
  if (closing) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (electron === undefined) {
      startElectron();
      return;
    }
    const runningElectron = electron;
    runningElectron.once("exit", startElectron);
    runningElectron.kill();
  }, 120);
}

const pack = NodeChildProcess.spawn(pnpm, ["exec", "vp", "pack", "--watch"], {
  cwd: packageRoot,
  stdio: "inherit",
});
pack.on("exit", (code) => {
  if (!closing) process.exitCode = code ?? 1;
});

const outputWatch = NodeFS.watch(outputDir, restartElectron);
startElectron();

function stop() {
  closing = true;
  outputWatch.close();
  clearTimeout(restartTimer);
  if (electron !== undefined) electron.kill();
  pack.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
