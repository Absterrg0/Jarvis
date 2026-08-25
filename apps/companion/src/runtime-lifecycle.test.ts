// @effect-diagnostics nodeBuiltinImport:off - this test owns a deliberately
// isolated child process so the controller/runtime lifecycle is observable.
// @effect-diagnostics globalFetch:off - the process-level harness deliberately
// uses the native HTTP API.
import * as NodeChildProcess from "node:child_process";

import { assert, describe, it } from "@effect/vitest";

import { disposeCompanionLocalRuntime } from "./runtime-lifecycle.ts";

type RuntimeMessage =
  | { readonly type: "ready"; readonly port: number }
  | { readonly type: "started" }
  | { readonly type: "completed"; readonly status: "completed" };

const executionRuntimeSource = `
  import http from "node:http";
  let pendingResponse;
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/task") {
      response.writeHead(404).end();
      return;
    }
    pendingResponse = response;
    process.send?.({ type: "started" });
  });
  server.listen(0, "127.0.0.1", () => {
    process.send?.({ type: "ready", port: server.address().port });
  });
  process.on("message", (message) => {
    if (message?.type !== "finish" || pendingResponse === undefined) return;
    const response = pendingResponse;
    pendingResponse = undefined;
    process.send?.({ type: "completed", status: "completed" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "completed" }));
  });
`;

function waitForRuntimeMessage<T extends RuntimeMessage["type"]>(
  runtime: NodeChildProcess.ChildProcess,
  expectedType: T,
): Promise<Extract<RuntimeMessage, { readonly type: T }>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      runtime.off("message", onMessage);
      runtime.off("exit", onExit);
      runtime.off("error", onError);
    };
    const onMessage = (message: RuntimeMessage) => {
      if (message.type !== expectedType) return;
      cleanup();
      resolve(message as Extract<RuntimeMessage, { readonly type: T }>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(`Isolated execution runtime exited before ${expectedType}: ${code ?? signal}`),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    runtime.on("message", onMessage);
    runtime.once("exit", onExit);
    runtime.once("error", onError);
  });
}

function waitForRuntimeExit(runtime: NodeChildProcess.ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const onExit = () => {
      runtime.off("exit", onExit);
      resolve();
    };
    runtime.once("exit", onExit);
    if (runtime.exitCode !== null || runtime.signalCode !== null) {
      runtime.off("exit", onExit);
      resolve();
    }
  });
}

describe("Companion runtime lifecycle", () => {
  it("cancels capture synchronously before disposing speech", async () => {
    const events: Array<string> = [];
    await disposeCompanionLocalRuntime({
      clearCaptureDeadlines: () => events.push("clear-deadlines"),
      cancelCapture: () => events.push("cancel-capture"),
      disposeSpeech: async () => {
        assert.deepEqual(events, ["clear-deadlines", "cancel-capture"]);
        events.push("dispose-speech");
      },
    });
    assert.deepEqual(events, ["clear-deadlines", "cancel-capture", "dispose-speech"]);
  });

  it("lets an independent execution runtime finish after Companion closes", async () => {
    const runtime = NodeChildProcess.spawn(
      process.execPath,
      ["--input-type=module", "--eval", executionRuntimeSource],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );

    try {
      const ready = await waitForRuntimeMessage(runtime, "ready");

      const started = waitForRuntimeMessage(runtime, "started");
      const completed = waitForRuntimeMessage(runtime, "completed");
      void started.catch(() => undefined);
      void completed.catch(() => undefined);
      const task = fetch(`http://127.0.0.1:${String(ready.port)}/task`, { method: "POST" });
      await started;

      await disposeCompanionLocalRuntime({
        disposeSpeech: async () => undefined,
      });

      assert.isNull(runtime.exitCode);
      assert.isNull(runtime.signalCode);
      runtime.send({ type: "finish" });
      assert.deepEqual(await completed, { type: "completed", status: "completed" });
      assert.equal((await (await task).json()).status, "completed");
    } finally {
      if (runtime.exitCode === null && runtime.signalCode === null) {
        runtime.kill("SIGTERM");
      }
      await waitForRuntimeExit(runtime);
    }
  });
});
