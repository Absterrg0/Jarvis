// @effect-diagnostics nodeBuiltinImport:off globalTimers:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DesktopJarvisVoiceState, DesktopJarvisVoiceStatus } from "@t3tools/contracts";
import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  type DesktopVoiceWorkerCommand,
  type DesktopVoiceWorkerMessage,
  parseDesktopVoiceWorkerMessage,
} from "./DesktopVoiceWorkerProtocol.ts";
import * as IpcChannels from "../ipc/channels.ts";

type VoiceChild = NodeChildProcess.ChildProcess;
type Pending = { readonly resolve: () => void; readonly reject: (cause: Error) => void };

const STARTUP_TIMEOUT_MS = 15_000;

const isNativePlatform = (platform: NodeJS.Platform): boolean =>
  platform === "darwin" || platform === "linux" || platform === "win32";

/**
 * Resolves the voice model directory from Desktop's own packaged resources.
 * Companion is an optional remote peripheral and is never a Desktop runtime
 * dependency.
 */
export function resolveDesktopJarvisVoiceResourceRoot(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly executablePath: string;
  readonly developmentResourceRoot: string;
  readonly exists?: (path: string) => boolean;
}): string | null {
  const path = input.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const exists = input.exists ?? NodeFS.existsSync;
  const candidates = input.isPackaged
    ? [path.join(input.resourcesPath, "jarvis-resources")]
    : [input.developmentResourceRoot];
  return candidates.find(exists) ?? null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function state(status: DesktopJarvisVoiceStatus, native: boolean, errorCode?: string) {
  return {
    status,
    native,
    ...(errorCode === undefined ? {} : { errorCode }),
  } satisfies DesktopJarvisVoiceState;
}

export interface DesktopJarvisVoice {
  readonly getState: () => DesktopJarvisVoiceState;
  readonly prepare: () => Promise<DesktopJarvisVoiceState>;
  readonly startCapture: () => Promise<{ readonly accepted: boolean }>;
  readonly releaseCapture: () => Promise<{ readonly accepted: boolean }>;
  readonly cancelCapture: () => Promise<{ readonly accepted: boolean }>;
  readonly speak: (text: string) => Promise<{ readonly accepted: boolean }>;
  readonly interrupt: () => Promise<{ readonly accepted: boolean }>;
  readonly stop: () => void;
}

export class DesktopJarvisVoiceService extends Context.Service<
  DesktopJarvisVoiceService,
  DesktopJarvisVoice
>()("@t3tools/desktop/voice/DesktopJarvisVoice/DesktopJarvisVoiceService") {}

export function createDesktopJarvisVoice(input: {
  readonly platform: NodeJS.Platform;
  readonly workerPath: string | null;
  readonly resourceRoot: string | null;
  readonly executablePath?: string;
  readonly spawn?: typeof NodeChildProcess.spawn;
  readonly emit?: (message: DesktopVoiceWorkerMessage) => void;
  readonly startupTimeoutMs?: number;
}): DesktopJarvisVoice {
  const native = isNativePlatform(input.platform);
  const executablePath = input.executablePath ?? process.execPath;
  const spawn = input.spawn ?? NodeChildProcess.spawn;
  const emit = input.emit ?? (() => undefined);
  let current = state(
    input.workerPath === null || input.resourceRoot === null || !native
      ? "unavailable"
      : "starting",
    native,
  );
  let child: VoiceChild | null = null;
  let startup: Promise<void> | null = null;
  let sequence = 0;
  let output = "";
  const pending = new Map<string, Pending>();

  const setState = (next: DesktopJarvisVoiceState) => {
    current = next;
    emit({ type: "state", state: next.status === "unavailable" ? "error" : next.status });
  };

  const failAll = (cause: Error) => {
    for (const request of pending.values()) request.reject(cause);
    pending.clear();
    child = null;
    startup = null;
    setState(state("error", native, "WORKER_EXITED"));
  };

  const handleMessage = (message: DesktopVoiceWorkerMessage): void => {
    if (message.type === "ready") {
      setState(state("ready", native));
      return;
    }
    if (message.type === "state") {
      setState(state(message.state, native));
      return;
    }
    if (message.type === "transcript") {
      emit(message);
      return;
    }
    if (message.type === "capture-result") {
      if (!message.ok) emit({ type: "error", message: message.message });
      return;
    }
    if (message.type === "fatal") {
      emit({
        type: "error",
        message: message.message,
        ...(message.code === undefined ? {} : { code: message.code }),
      });
      setState(state("error", native, message.code ?? "VOICE_UNAVAILABLE"));
      return;
    }
    if (message.type !== "result") return;
    const request = pending.get(message.requestId);
    if (request === undefined) return;
    pending.delete(message.requestId);
    if (message.ok) request.resolve();
    else request.reject(new Error(message.message));
  };

  const send = (type: DesktopVoiceWorkerCommand["type"], extra: Record<string, unknown> = {}) => {
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      return Promise.reject(new Error("Jarvis native voice worker is not running."));
    }
    const requestId = `voice-${sequence++}`;
    const command = { type, requestId, ...extra };
    return new Promise<void>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      child?.stdin?.write(`${JSON.stringify(command)}\n`, (cause) => {
        if (cause === undefined || cause === null) return;
        pending.delete(requestId);
        reject(cause);
      });
    });
  };

  const ensureWorker = async (): Promise<void> => {
    if (!native || input.workerPath === null || input.resourceRoot === null) {
      throw new Error("Native voice is unavailable on this platform.");
    }
    if (child !== null && current.status !== "error") return;
    if (startup !== null) return startup;
    if (child !== null) {
      // A fatal worker message can leave the process alive. Do not layer a
      // second worker over it on Retry: clear its pending requests and stop it
      // before replacing the handle.
      const staleChild = child;
      child = null;
      for (const request of pending.values()) {
        request.reject(new Error("Voice worker restarted."));
      }
      pending.clear();
      if (!staleChild.killed) staleChild.kill("SIGTERM");
    }
    startup = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        if (child !== null && !child.killed) child.kill("SIGTERM");
        settled = true;
        reject(new Error("Native voice worker did not become ready."));
      }, input.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
      const finish = (cause?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cause === undefined) resolve();
        else reject(cause);
      };
      try {
        child = spawn(executablePath, [input.workerPath!], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            JARVIS_VOICE_ROOT: input.resourceRoot!,
            JARVIS_KOKORO_ROOT: NodePath.join(input.resourceRoot!, "kokoro"),
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (cause) {
        finish(new Error(errorMessage(cause)));
        return;
      }
      const activeChild = child;
      activeChild.stdout?.on("data", (chunk: Buffer | string) => {
        output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const lines = output.split(/\r?\n/u);
        output = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const parsed: unknown = JSON.parse(line);
            const message = parseDesktopVoiceWorkerMessage(parsed);
            if (message !== null) {
              handleMessage(message);
              if (message.type === "ready") finish();
              if (message.type === "fatal") finish(new Error(message.message));
            }
          } catch {
            // Keep the protocol line-oriented and ignore diagnostics that do
            // not conform to the worker contract.
          }
        }
      });
      activeChild.stderr?.on("data", () => undefined);
      activeChild.once("error", (cause) => {
        failAll(cause instanceof Error ? cause : new Error(String(cause)));
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      });
      activeChild.once("exit", (code) => {
        if (!settled) finish(new Error(`Native voice worker exited (${code ?? "unknown"}).`));
        if (child === activeChild) failAll(new Error("Native voice worker exited."));
      });
    }).finally(() => {
      startup = null;
    });
    try {
      await startup;
    } catch (cause) {
      setState(state("error", native, "WORKER_START_FAILED"));
      throw cause;
    }
  };

  const command = async (
    type: DesktopVoiceWorkerCommand["type"],
    extra?: Record<string, unknown>,
  ): Promise<{ readonly accepted: boolean }> => {
    try {
      await ensureWorker();
      await send(type, extra);
      return { accepted: true };
    } catch {
      return { accepted: false };
    }
  };

  return {
    getState: () => current,
    prepare: async () => {
      await ensureWorker();
      await send("prepare");
      return current;
    },
    startCapture: () => command("capture-start"),
    releaseCapture: () => command("capture-release"),
    cancelCapture: () => command("capture-cancel"),
    speak: (text) =>
      text.trim().length === 0 ? Promise.resolve({ accepted: false }) : command("speak", { text }),
    interrupt: () => command("interrupt"),
    stop: () => {
      const activeChild = child;
      child = null;
      startup = null;
      for (const request of pending.values()) request.reject(new Error("Voice worker stopped."));
      pending.clear();
      if (activeChild !== null && !activeChild.killed) activeChild.kill("SIGTERM");
      if (native) setState(state("unavailable", native));
    },
  };
}

export const layer = Layer.effect(
  DesktopJarvisVoiceService,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const workerPath = NodePath.join(environment.dirname, "desktopVoiceWorker.cjs");
    const resourceRoot = resolveDesktopJarvisVoiceResourceRoot({
      platform: environment.platform,
      isPackaged: environment.isPackaged,
      resourcesPath: environment.resourcesPath,
      executablePath: environment.executablePath,
      developmentResourceRoot: NodePath.resolve(
        environment.dirname,
        "../../../packages/jarvis-native-voice/resources",
      ),
    });
    return createDesktopJarvisVoice({
      platform: environment.platform,
      workerPath,
      resourceRoot,
      executablePath: environment.executablePath,
      emit: (message) => {
        if (message.type === "state") {
          const next = state(message.state, isNativePlatform(environment.platform));
          for (const window of Electron.BrowserWindow.getAllWindows()) {
            window.webContents.send(IpcChannels.JARVIS_VOICE_STATE_CHANNEL, next);
          }
        } else if (message.type === "transcript") {
          for (const window of Electron.BrowserWindow.getAllWindows()) {
            window.webContents.send(IpcChannels.JARVIS_VOICE_TRANSCRIPT_CHANNEL, message.text);
          }
        } else if (message.type === "error") {
          for (const window of Electron.BrowserWindow.getAllWindows()) {
            window.webContents.send(IpcChannels.JARVIS_VOICE_ERROR_CHANNEL, message.message);
          }
        }
      },
    });
  }),
);
