import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [appBundle, receiptPath, version, targetArch, logPath] = process.argv.slice(2);
if (!appBundle || !receiptPath || !version || !targetArch || !logPath) {
  throw new Error(
    "usage: node scripts/mac-desktop-startup-smoke.mjs <app-bundle> <receipt> <version> <arm64|x64> <log>",
  );
}
if (!appBundle.endsWith(".app") || !NodeFS.existsSync(appBundle)) {
  throw new Error(`Jarvis app bundle does not exist: ${appBundle}`);
}
if (targetArch !== "arm64" && targetArch !== "x64") {
  throw new Error(`Unsupported target architecture: ${targetArch}`);
}

const hostMachine = NodeChildProcess.execFileSync("uname", ["-m"], {
  encoding: "utf8",
}).trim();
const hostArch = hostMachine === "arm64" ? "arm64" : hostMachine === "x86_64" ? "x64" : null;
if (hostArch === null) throw new Error(`Unsupported macOS runner architecture: ${hostMachine}`);
if (hostArch !== targetArch) {
  throw new Error(
    `Cannot launch ${targetArch} artifact on ${hostMachine} runner: native architecture mismatch.`,
  );
}

const launchCommand = "/usr/bin/open";
const launchArgs = ["-n", "-W", appBundle, "--args"];
const jarvisBundleId = "com.abstergo.jarvis";

const expectedReceipt = {
  schemaVersion: 1,
  product: "Jarvis",
  version,
  platform: "darwin",
  phase: "main-window-revealed",
};
const MAX_LOG_BYTES = 32 * 1024;

const printBoundedLog = () => {
  try {
    const contents = NodeFS.readFileSync(logPath);
    const bounded =
      contents.length > MAX_LOG_BYTES
        ? contents.subarray(contents.length - MAX_LOG_BYTES)
        : contents;
    const prefix =
      contents.length > MAX_LOG_BYTES
        ? `\n--- Jarvis startup log (last ${MAX_LOG_BYTES} bytes) ---\n`
        : "\n--- Jarvis startup log ---\n";
    process.stderr.write(`${prefix}${bounded.toString("utf8")}\n--- end Jarvis startup log ---\n`);
  } catch (cause) {
    process.stderr.write(`Unable to read Jarvis startup log ${logPath}: ${String(cause)}\n`);
  }
};

const readReceipt = () => {
  if (!NodeFS.existsSync(receiptPath)) return false;
  let value;
  try {
    value = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8"));
  } catch (cause) {
    throw new Error(`Startup receipt is not valid JSON: ${String(cause)}`, { cause });
  }
  if (JSON.stringify(value) !== JSON.stringify(expectedReceipt)) {
    throw new Error(`Unexpected startup receipt: ${JSON.stringify(value)}`);
  }
  return true;
};

const child = NodeChildProcess.spawn(
  launchCommand,
  [...launchArgs, `--jarvis-startup-probe=${receiptPath}`],
  {
    stdio: ["ignore", "pipe", "pipe"],
  },
);
if (child.pid === undefined) throw new Error("Could not capture the LaunchServices process PID.");
const pid = child.pid;
const log = NodeFS.createWriteStream(logPath, { flags: "w" });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });

let settled = false;
let watcher;
let timer;
let childExitResult;
const childExit = new Promise((resolve) => {
  child.once("exit", (code, signal) => {
    childExitResult = { code, signal };
    resolve();
  });
});

const waitForChildExit = (timeoutMs) =>
  Promise.race([
    childExit,
    new Promise((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs);
      timeout.unref();
    }),
  ]);

const stop = async () => {
  watcher?.close();
  if (timer !== undefined) clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      NodeChildProcess.execFileSync(
        "/usr/bin/osascript",
        ["-e", `tell application id "${jarvisBundleId}" to quit`],
        { stdio: "ignore" },
      );
    } catch {
      // The app may have exited before the exact bundle quit request.
    }
  }
  await waitForChildExit(5_000);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await waitForChildExit(5_000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The captured process exited between the liveness check and kill.
    }
  }
  await new Promise((resolve) => log.end(resolve));
};

let startupSucceeded = false;
try {
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      if (timer !== undefined) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const inspect = () => {
      try {
        if (readReceipt()) finish();
      } catch (error) {
        finish(error);
      }
    };
    watcher = NodeFS.watch(NodePath.dirname(receiptPath), (_event, changed) => {
      if (changed === undefined || changed.toString() === NodePath.basename(receiptPath)) inspect();
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(
          new Error(
            `Jarvis LaunchServices handle PID ${pid} exited before startup receipt (code=${code ?? "none"}, signal=${signal ?? "none"}).`,
          ),
        );
      }
    });
    timer = setTimeout(
      () =>
        finish(
          new Error(
            `Startup receipt timeout for captured Jarvis LaunchServices handle PID ${pid}.`,
          ),
        ),
      90_000,
    );
    timer.unref();
    // Cover a receipt written between the initial spawn and fs.watch setup.
    inspect();
  });
  startupSucceeded = true;
  process.stdout.write(
    `Jarvis startup receipt verified for LaunchServices handle PID ${pid} on ${targetArch}.\n`,
  );
} finally {
  await stop();
  if (!startupSucceeded) {
    printBoundedLog();
  } else if (childExitResult && childExitResult.code !== 0 && childExitResult.signal === null) {
    process.stderr.write(`Jarvis startup log: ${logPath}\n`);
  }
}
