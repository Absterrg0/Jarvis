// @effect-diagnostics nodeBuiltinImport:off - this test owns a deliberately
// isolated child process so the controller/runtime lifecycle is observable.
// @effect-diagnostics globalDate:off globalTimers:off globalFetch:off - the
// process-level harness deliberately uses native Node timing and HTTP APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { disposeCompanionLocalRuntime } from "./runtime-lifecycle.ts";

type RuntimeMessage = { readonly type: "ready"; readonly port: number };

const executionRuntimeSource = `
  import http from "node:http";
  import fs from "node:fs";
  const startedPath = process.env.JARVIS_TEST_STARTED;
  const completedPath = process.env.JARVIS_TEST_COMPLETED;
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/task") {
      response.writeHead(404).end();
      return;
    }
    fs.writeFileSync(startedPath, "started");
    setTimeout(() => {
      fs.writeFileSync(completedPath, "completed");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "completed" }));
    }, 150);
  });
  server.listen(0, "127.0.0.1", () => {
    process.send({ type: "ready", port: server.address().port });
  });
  process.on("disconnect", () => {});
`;

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the isolated execution runtime.");
}

describe("Companion runtime lifecycle", () => {
  it("lets an independent execution runtime finish after Companion closes", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "jarvis-companion-lifecycle-"),
    );
    const startedPath = NodePath.join(root, "started");
    const completedPath = NodePath.join(root, "completed");
    const runtime = NodeChildProcess.spawn(
      process.execPath,
      ["--input-type=module", "--eval", executionRuntimeSource],
      {
        env: {
          ...process.env,
          JARVIS_TEST_STARTED: startedPath,
          JARVIS_TEST_COMPLETED: completedPath,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );

    try {
      const ready = await waitFor<RuntimeMessage>(
        () =>
          new Promise((resolve) => {
            const onMessage = (message: RuntimeMessage) => {
              runtime.off("message", onMessage);
              resolve(message);
            };
            runtime.once("message", onMessage);
          }),
      );
      assert.equal(ready.type, "ready");

      const task = fetch(`http://127.0.0.1:${String(ready.port)}/task`, { method: "POST" });
      await waitFor(async () => {
        try {
          await NodeFSP.access(startedPath);
          return true;
        } catch {
          return undefined;
        }
      });

      await disposeCompanionLocalRuntime({
        disposeSpeech: async () => undefined,
      });

      assert.isNull(runtime.exitCode);
      assert.isNull(runtime.signalCode);
      assert.equal((await (await task).json()).status, "completed");
      await waitFor(async () => {
        try {
          return await NodeFSP.readFile(completedPath, "utf8");
        } catch {
          return undefined;
        }
      });
    } finally {
      if (runtime.exitCode === null && runtime.signalCode === null) {
        runtime.kill("SIGTERM");
      }
      await new Promise<void>((resolve) => {
        if (runtime.exitCode !== null || runtime.signalCode !== null) {
          resolve();
          return;
        }
        runtime.once("exit", () => resolve());
      });
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
