// oxlint-disable t3code/no-global-process-runtime -- standalone hardware benchmark.
// Run with Node 24. Uses the production worker/client and never opens an audio device.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeURL from "node:url";

import { bundledKokoroVoicePaths, startKokoroWorker } from "../src/kokoro-worker-client.ts";

const argumentsByName = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    if (separator === -1) throw new Error(`Expected --name=value, received ${argument}`);
    return [argument.slice(0, separator), argument.slice(separator + 1)];
  }),
);
for (const name of argumentsByName.keys()) {
  if (!["--threads", "--warm-runs", "--resource-root"].includes(name)) {
    throw new Error(`Unknown option ${name}`);
  }
}
const threadCounts = (argumentsByName.get("--threads") ?? "2,3,4").split(",").map(Number);
const warmRuns = Number(argumentsByName.get("--warm-runs") ?? "3");
if (threadCounts.some((value) => !Number.isInteger(value) || value < 1 || value > 4)) {
  throw new Error("Thread counts must be integers between 1 and 4.");
}
if (!Number.isInteger(warmRuns) || warmRuns < 1 || warmRuns > 10) {
  throw new Error("Warm runs must be between 1 and 10.");
}

const text =
  "The task is complete. I updated the login flow and added regression tests. " +
  "All targeted checks passed. You can review the changes in the workspace.";
const paths = bundledKokoroVoicePaths(argumentsByName.get("--resource-root"));
const workerPath = NodeURL.fileURLToPath(new URL("../src/kokoro-worker.ts", import.meta.url));
const loopDelay = NodePerfHooks.monitorEventLoopDelay({ resolution: 10 });
const cancellation = new AbortController();
const stop = () => cancellation.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
loopDelay.enable();
console.log(
  JSON.stringify({
    event: "benchmark-config",
    cpu: NodeOS.cpus()[0]?.model,
    logicalCpus: NodeOS.cpus().length,
    os: `${NodeOS.platform()} ${NodeOS.release()}`,
    node: process.version,
    threadCounts,
    warmRuns,
    measurement: "First playable WAV at the consumer; excludes audio device/player startup.",
    coldDefinition: "New Kokoro process/model; OS file cache is not flushed.",
  }),
);

try {
  for (const numThreads of threadCounts) {
    cancellation.signal.throwIfAborted();
    const coldStart = NodePerfHooks.performance.now();
    const worker = await startKokoroWorker({
      paths,
      workerPath,
      numThreads,
      signal: cancellation.signal,
    });
    const warmupMs = NodePerfHooks.performance.now() - coldStart;
    try {
      for (let trial = 0; trial <= warmRuns; trial += 1) {
        cancellation.signal.throwIfAborted();
        loopDelay.reset();
        const startedAt = trial === 0 ? coldStart : NodePerfHooks.performance.now();
        let firstPlayableChunkMs;
        let chunks = 0;
        const metrics = await worker.synthesize(
          text,
          async (path, index) => {
            const wav = await NodeFSP.readFile(path);
            if (wav.length <= 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
              throw new Error("Worker emitted an empty or invalid WAV.");
            }
            if (index !== chunks) throw new Error("Chunk order changed.");
            chunks += 1;
            firstPlayableChunkMs ??= NodePerfHooks.performance.now() - startedAt;
          },
          cancellation.signal,
        );
        if (chunks < 2 || firstPlayableChunkMs === undefined) {
          throw new Error("Expected incremental audio for this multi-sentence response.");
        }
        console.log(
          JSON.stringify({
            event: "benchmark-result",
            numThreads,
            trial,
            start: trial === 0 ? "cold" : "warm",
            warmupMs: trial === 0 ? warmupMs : 0,
            firstPlayableChunkMs,
            // The old path waited for this whole-response boundary before playback.
            fullResponseReadyMs: metrics.synthesisDurationMs + (trial === 0 ? warmupMs : 0),
            requestDurationMs: NodePerfHooks.performance.now() - startedAt,
            parentEventLoopP99Ms: loopDelay.percentile(99) / 1e6,
            parentEventLoopMaxMs: loopDelay.max / 1e6,
            ...metrics,
          }),
        );
      }
    } finally {
      await worker.close();
    }
  }
} finally {
  loopDelay.disable();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
