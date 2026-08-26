// @effect-diagnostics nodeBuiltinImport:off - the native child is replaced by a deterministic IPC fake.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { bundledKokoroVoicePaths, startKokoroWorker } from "./kokoro-worker-client.ts";

type SentRequest = {
  readonly type: "synthesize";
  readonly requestId: string;
  readonly outputDirectory: string;
};

function childHarness() {
  const requestSent = Promise.withResolvers<SentRequest>();
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stderr: new NodeEvents.EventEmitter(),
    connected: true,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killSignals: [] as string[],
    request: undefined as SentRequest | undefined,
    send(value: unknown, callback?: (cause: Error | null) => void) {
      const request = value as SentRequest;
      if (request.type === "synthesize") {
        child.request = request;
        requestSent.resolve(request);
      }
      callback?.(null);
      return true;
    },
    kill(signal = "SIGTERM") {
      child.killed = true;
      child.connected = false;
      child.killSignals.push(signal);
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    },
  });
  const spawnWorker = () => {
    queueMicrotask(() => child.emit("message", { type: "ready" }));
    return child;
  };
  const emitChunk = async (index: number) => {
    const request = child.request;
    if (request === undefined) throw new Error("No synthesis request was sent.");
    await NodeFSP.writeFile(
      NodePath.join(request.outputDirectory, `chunk-${String(index).padStart(6, "0")}.wav`),
      "RIFF-chunk",
    );
    child.emit("message", { type: "chunk", requestId: request.requestId, index });
  };
  const finish = (chunkCount: number) => {
    const request = child.request;
    if (request === undefined) throw new Error("No synthesis request was sent.");
    child.emit("message", {
      type: "synthesis-finished",
      requestId: request.requestId,
      chunkCount,
      totalSamples: chunkCount * 24_000,
      sampleRate: 24_000,
      synthesisDurationMs: 50,
      synthesisCpuMs: 80,
      peakRssBytes: 400_000_000,
      firstChunkReadyMs: 10,
    });
  };
  return { child, spawnWorker, requestSent: requestSent.promise, emitChunk, finish };
}

describe("Kokoro worker client", () => {
  it("plays emitted chunks in order without overlap and removes request files", async () => {
    const test = childHarness();
    const worker = await startKokoroWorker({
      paths: bundledKokoroVoicePaths(),
      spawnWorker: test.spawnWorker as never,
    });
    const firstPlayback = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const order: number[] = [];
    let activeConsumers = 0;
    let maxConsumers = 0;
    const synthesis = worker.synthesize("Two sentences.", async (_path, index) => {
      activeConsumers += 1;
      maxConsumers = Math.max(maxConsumers, activeConsumers);
      order.push(index);
      if (index === 0) {
        firstPlayback.resolve();
        await releaseFirst.promise;
      }
      activeConsumers -= 1;
    });
    const { outputDirectory } = await test.requestSent;
    await test.emitChunk(0);
    await test.emitChunk(1);
    test.finish(2);
    await firstPlayback.promise;
    assert.deepEqual(order, [0]);
    releaseFirst.resolve();
    const metrics = await synthesis;
    assert.deepEqual(order, [0, 1]);
    assert.equal(maxConsumers, 1);
    assert.equal(metrics.chunkCount, 2);
    assert.isFalse(
      await NodeFSP.stat(outputDirectory).then(
        () => true,
        () => false,
      ),
    );
    await worker.close();
  });

  it("cancels playback, stops the worker, ignores late chunks, and cleans files", async () => {
    const test = childHarness();
    const worker = await startKokoroWorker({
      paths: bundledKokoroVoicePaths(),
      spawnWorker: test.spawnWorker as never,
    });
    const controller = new AbortController();
    const playbackStarted = Promise.withResolvers<void>();
    const synthesis = worker.synthesize(
      "Cancel me.",
      async () => {
        playbackStarted.resolve();
        await new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
      controller.signal,
    );
    const { outputDirectory } = await test.requestSent;
    await test.emitChunk(0);
    await playbackStarted.promise;
    controller.abort();
    test.child.emit("message", {
      type: "chunk",
      requestId: test.child.request?.requestId,
      index: 1,
    });
    const failure = await synthesis.catch((cause: unknown) => cause);
    assert.instanceOf(failure, DOMException);
    assert.equal((failure as DOMException).name, "AbortError");
    assert.include(test.child.killSignals, "SIGTERM");
    assert.isFalse(
      await NodeFSP.stat(outputDirectory).then(
        () => true,
        () => false,
      ),
    );
    await worker.close();
  });

  it("rejects thread counts outside the profiled range", async () => {
    const failure = await startKokoroWorker({
      paths: bundledKokoroVoicePaths(),
      numThreads: 8,
    }).catch((cause: unknown) => cause);
    assert.instanceOf(failure, Error);
    assert.match((failure as Error).message, /between 1 and 4/u);
  });
});
