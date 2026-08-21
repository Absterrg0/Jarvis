// oxlint-disable t3code/no-global-process-runtime -- this file owns the disposable native worker.
// @effect-diagnostics nodeBuiltinImport:off globalProcess:off - the Companion deliberately
// isolates Kokoro in a disposable child process so model memory is returned to the OS.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import type { KokoroWorker } from "./kokoro-lifecycle.ts";

export type KokoroVoicePaths = {
  readonly resourceRoot: string;
  readonly modelPath: string;
  readonly voicesPath: string;
  readonly tokensPath: string;
  readonly dataDir: string;
  readonly lexiconPath: string;
};

export function kokoroVoicePaths(resourceRoot: string): KokoroVoicePaths {
  return {
    resourceRoot,
    modelPath: NodePath.join(resourceRoot, "model.int8.onnx"),
    voicesPath: NodePath.join(resourceRoot, "voices.bin"),
    tokensPath: NodePath.join(resourceRoot, "tokens.txt"),
    dataDir: NodePath.join(resourceRoot, "espeak-ng-data"),
    lexiconPath: NodePath.join(resourceRoot, "lexicon-us-en.txt"),
  };
}

export function bundledKokoroVoicePaths(): KokoroVoicePaths {
  const packagedRoot =
    typeof process.resourcesPath === "string"
      ? NodePath.join(process.resourcesPath, "jarvis-resources", "kokoro")
      : undefined;
  const resourceRoot =
    packagedRoot !== undefined && NodeFS.existsSync(NodePath.join(packagedRoot, "model.int8.onnx"))
      ? packagedRoot
      : NodePath.resolve(import.meta.dirname, "../resources/kokoro");
  return kokoroVoicePaths(resourceRoot);
}

export function kokoroResourceError(paths: KokoroVoicePaths): Error | undefined {
  const resources: ReadonlyArray<readonly [string, string]> = [
    [paths.modelPath, "Kokoro model"],
    [paths.voicesPath, "Kokoro voices"],
    [paths.tokensPath, "Kokoro tokens"],
    [paths.dataDir, "Kokoro pronunciation data"],
    [paths.lexiconPath, "Kokoro English lexicon"],
  ];
  const missing = resources.find(([path]) => !NodeFS.existsSync(path));
  return missing === undefined
    ? undefined
    : new Error(
        `Jarvis voice is unavailable because the bundled ${missing[1]} is missing. Reinstall Jarvis Companion.`,
      );
}

type PendingSynthesis = {
  readonly resolve: (path: string) => void;
  readonly reject: (cause: Error) => void;
  readonly outputPath: string;
};

type WorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "startup-failed"; readonly message: string }
  | { readonly type: "synthesized"; readonly requestId: string }
  | { readonly type: "failed"; readonly requestId: string; readonly message: string };

function parseWorkerMessage(value: unknown): WorkerMessage | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  const candidate = value as Partial<WorkerMessage>;
  if (candidate.type === "ready") return { type: "ready" };
  if (candidate.type === "startup-failed" && typeof candidate.message === "string") {
    return { type: candidate.type, message: candidate.message };
  }
  if (candidate.type === "synthesized" && typeof candidate.requestId === "string") {
    return { type: candidate.type, requestId: candidate.requestId };
  }
  if (candidate.type === "failed" && typeof candidate.requestId === "string") {
    const failed = value as Partial<Extract<WorkerMessage, { readonly type: "failed" }>>;
    return typeof failed.message === "string"
      ? { type: candidate.type, requestId: candidate.requestId, message: failed.message }
      : undefined;
  }
  return undefined;
}

export async function startKokoroWorker(
  input: {
    readonly paths?: KokoroVoicePaths;
    readonly workerPath?: string;
    readonly spawnWorker?: typeof NodeChildProcess.fork;
    readonly startupTimeoutMs?: number;
  } = {},
): Promise<KokoroWorker> {
  const paths = input.paths ?? bundledKokoroVoicePaths();
  const resourceError = kokoroResourceError(paths);
  if (resourceError !== undefined) throw resourceError;
  const spawnWorker = input.spawnWorker ?? NodeChildProcess.fork;
  const child: NodeChildProcess.ChildProcess = spawnWorker(
    input.workerPath ?? NodePath.join(import.meta.dirname, "kokoro-worker.cjs"),
    [],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        JARVIS_KOKORO_ROOT: paths.resourceRoot,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-4_096);
  });
  let closed = false;
  const pending = new Map<string, PendingSynthesis>();
  const rejectPending = (cause: Error) => {
    for (const request of pending.values()) request.reject(cause);
    pending.clear();
  };

  await new Promise<void>((resolveReady, rejectReady) => {
    let settled = false;
    const timeout = new AbortController();
    const finish = (cause?: Error) => {
      if (settled) return;
      settled = true;
      timeout.abort();
      if (cause === undefined) resolveReady();
      else rejectReady(cause);
    };
    void NodeTimersPromises.setTimeout(input.startupTimeoutMs ?? 30_000, undefined, {
      signal: timeout.signal,
    })
      .then(() => finish(new Error("Kokoro took too long to warm.")))
      .catch(() => undefined);
    child.once("error", (cause) => finish(cause));
    child.once("exit", (code, signal) => {
      const detail = diagnostics.trim().split(/\r?\n/u).at(-1);
      finish(
        new Error(
          detail ??
            `Kokoro stopped while warming${signal === null ? ` (exit ${code ?? "unknown"})` : ` (${signal})`}.`,
        ),
      );
    });
    child.on("message", (value) => {
      const message = parseWorkerMessage(value);
      if (message?.type === "ready") finish();
      if (message?.type === "startup-failed") finish(new Error(message.message));
    });
  }).catch((cause) => {
    if (!child.killed) child.kill();
    throw cause;
  });

  child.on("message", (value) => {
    const message = parseWorkerMessage(value);
    if (message?.type !== "synthesized" && message?.type !== "failed") return;
    const request = pending.get(message.requestId);
    if (request === undefined) return;
    pending.delete(message.requestId);
    if (message.type === "synthesized") request.resolve(request.outputPath);
    else request.reject(new Error(message.message));
  });
  child.once("exit", () => {
    closed = true;
    rejectPending(new Error("Kokoro stopped before speech was ready."));
  });

  return {
    synthesize(text) {
      if (closed || child.connected !== true) {
        return Promise.reject(new Error("Kokoro is not ready."));
      }
      const requestId = NodeCrypto.randomUUID();
      const outputPath = NodePath.join(NodeOS.tmpdir(), `jarvis-kokoro-${requestId}.wav`);
      return new Promise<string>((resolveSynthesis, rejectSynthesis) => {
        pending.set(requestId, {
          resolve: resolveSynthesis,
          reject: rejectSynthesis,
          outputPath,
        });
        child.send({ type: "synthesize", requestId, text, outputPath }, (cause) => {
          if (cause === null || cause === undefined) return;
          pending.delete(requestId);
          rejectSynthesis(cause);
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      rejectPending(new DOMException("Jarvis speech was interrupted.", "AbortError"));
      const exited =
        child.exitCode === null && child.signalCode === null
          ? new Promise<void>((resolveClose) => child.once("exit", () => resolveClose()))
          : Promise.resolve();
      if (!child.killed) child.kill();
      await exited;
    },
  };
}
