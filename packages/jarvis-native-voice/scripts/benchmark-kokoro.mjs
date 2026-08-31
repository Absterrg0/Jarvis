// oxlint-disable t3code/no-global-process-runtime -- standalone hardware benchmark.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeReadline from "node:readline";

const argumentsByName = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    if (separator === -1) throw new Error(`Expected --name=value, received ${argument}`);
    return [argument.slice(0, separator), argument.slice(separator + 1)];
  }),
);
for (const name of argumentsByName.keys()) {
  if (!["--warm-runs", "--resource-root", "--project-root"].includes(name)) {
    throw new Error(`Unknown option ${name}`);
  }
}
const warmRuns = Number(argumentsByName.get("--warm-runs") ?? "3");
if (!Number.isInteger(warmRuns) || warmRuns < 1 || warmRuns > 10) {
  throw new Error("Warm runs must be between 1 and 10.");
}

const resourceRoot = NodePath.resolve(
  argumentsByName.get("--resource-root") ?? NodePath.resolve(import.meta.dirname, "../resources"),
);
const projectRoot = NodePath.resolve(
  argumentsByName.get("--project-root") ??
    NodePath.resolve(import.meta.dirname, "../../../apps/desktop/pipecat"),
);
const child = NodeChildProcess.spawn(
  "uv",
  ["run", "--project", projectRoot, "python", NodePath.resolve(projectRoot, "scripts/launch.py")],
  {
    env: {
      ...process.env,
      JARVIS_PIPECAT_MODEL_ROOT: NodePath.resolve(resourceRoot, "parakeet"),
      JARVIS_PIPECAT_KOKORO_ROOT: NodePath.resolve(resourceRoot, "kokoro"),
    },
    stdio: ["pipe", "pipe", "inherit"],
  },
);
const pending = [];
const received = [];
const awaitMessage = (matches) => {
  const existingIndex = received.findIndex(matches);
  if (existingIndex >= 0) return Promise.resolve(received.splice(existingIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Pipecat.")), 120_000);
    pending.push({
      matches,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
  });
};
NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    child.kill();
    throw new Error(`Pipecat emitted malformed JSON: ${line}`);
  }
  const index = pending.findIndex(({ matches }) => matches(message));
  if (index >= 0) pending.splice(index, 1)[0].resolve(message);
  else received.push(message);
});
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const text =
  "The task is complete. I updated the login flow and added regression tests. " +
  "All targeted checks passed. You can review the changes in the workspace.";

try {
  const processStartedAt = NodePerfHooks.performance.now();
  await awaitMessage((message) => message.type === "ready");
  send({ type: "speech-prepare", requestId: "benchmark-prepare" });
  await awaitMessage(
    (message) => message.type === "result" && message.requestId === "benchmark-prepare",
  );
  console.log(
    JSON.stringify({
      event: "benchmark-config",
      cpu: NodeOS.cpus()[0]?.model,
      logicalCpus: NodeOS.cpus().length,
      os: `${NodeOS.platform()} ${NodeOS.release()}`,
      node: process.version,
      warmRuns,
      runtime: "production-pipecat",
      measurement: "Pipecat synthesis and production audio-output timing.",
    }),
  );
  for (let trial = 0; trial <= warmRuns; trial += 1) {
    const speechId = `benchmark-${trial}`;
    const startedAt = trial === 0 ? processStartedAt : NodePerfHooks.performance.now();
    send({ type: "speech-start", requestId: `${speechId}-start`, speechId, text });
    const result = await awaitMessage(
      (message) => message.type === "speech-result" && message.speechId === speechId,
    );
    if (result.status !== "completed") {
      throw new Error(`Pipecat speech failed: ${result.message ?? result.status}`);
    }
    console.log(
      JSON.stringify({
        event: "benchmark-result",
        trial,
        start: trial === 0 ? "cold" : "warm",
        elapsedMs: NodePerfHooks.performance.now() - startedAt,
        ...result.timing,
      }),
    );
  }
  send({ type: "shutdown", requestId: "benchmark-shutdown" });
  await awaitMessage(
    (message) => message.type === "result" && message.requestId === "benchmark-shutdown",
  );
} finally {
  child.kill();
}
