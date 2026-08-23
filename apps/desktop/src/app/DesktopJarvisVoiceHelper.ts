// @effect-diagnostics nodeBuiltinImport:off globalTimers:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export type DesktopJarvisVoiceHelperStatus =
  | "unavailable"
  | "installed"
  | "starting"
  | "running"
  | "configured"
  | "error";

export interface DesktopJarvisVoiceHelperState {
  readonly status: DesktopJarvisVoiceHelperStatus;
  readonly executablePath: string | null;
  readonly configured: boolean;
  readonly errorCode?: string;
}

export interface DesktopJarvisVoiceHelperProcess {
  readonly stdin?: {
    readonly write: (chunk: string) => boolean;
    readonly end: () => unknown;
  } | null;
  readonly stdout?: {
    on: (event: "data", listener: (chunk: unknown) => void) => unknown;
  } | null;
  readonly stderr?: {
    on: (event: "data", listener: (chunk: unknown) => void) => unknown;
  } | null;
  readonly pid?: number;
  once: (event: "error" | "exit", listener: (...args: Array<unknown>) => void) => unknown;
  readonly kill: (signal?: NodeJS.Signals) => boolean;
}

export interface DesktopJarvisVoiceHelperSpawnOptions {
  readonly stdio: ["ignore" | "pipe", "pipe" | "ignore", "pipe" | "ignore"];
  readonly windowsHide: boolean;
}

export type DesktopJarvisVoiceHelperSpawn = (
  executablePath: string,
  args: readonly string[],
  options: DesktopJarvisVoiceHelperSpawnOptions,
) => DesktopJarvisVoiceHelperProcess;

const managedReadyPrefix = "JARVIS_MANAGED_READY";
const managedPairedPrefix = "JARVIS_MANAGED_PAIRED";
const managedErrorPrefix = "JARVIS_MANAGED_ERROR";
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;

function readConfigured(configurationPath: string | undefined): boolean {
  if (configurationPath === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(configurationPath, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "configured" in parsed &&
      parsed.configured === true
    );
  } catch {
    return false;
  }
}

function persistConfigured(configurationPath: string | undefined): void {
  if (configurationPath === undefined) return;
  try {
    NodeFS.mkdirSync(NodePath.dirname(configurationPath), { recursive: true });
    NodeFS.writeFileSync(configurationPath, '{"configured":true}\n', "utf8");
  } catch {
    // Pairing remains usable if the optional local state write fails.
  }
}

function companionCandidates(input: {
  readonly platform: NodeJS.Platform;
  readonly desktopExecutablePath: string;
  readonly resourcesPath?: string;
}): readonly string[] {
  const path = input.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const installRoot = path.dirname(path.dirname(input.desktopExecutablePath));
  if (input.platform === "win32") {
    return [
      path.join(installRoot, "companion", "Jarvis Companion.exe"),
      path.join(installRoot, "companion", "jarvis-companion.exe"),
    ];
  }
  const resourceCandidates = input.resourcesPath
    ? [
        path.join(input.resourcesPath, "companion", "jarvis-companion"),
        path.join(input.resourcesPath, "companion", "Jarvis Companion"),
      ]
    : [];
  return [
    ...resourceCandidates,
    path.join(installRoot, "companion", "jarvis-companion"),
    path.join(installRoot, "companion", "Jarvis Companion"),
  ];
}

export function resolveDesktopJarvisCompanionExecutable(input: {
  readonly platform: NodeJS.Platform;
  readonly desktopExecutablePath: string;
  readonly resourcesPath?: string;
  readonly exists?: (path: string) => boolean;
}): string | null {
  const exists = input.exists ?? NodeFS.existsSync;
  return companionCandidates(input).find((candidate) => exists(candidate)) ?? null;
}

export interface CreateDesktopJarvisVoiceHelperInput {
  readonly platform: NodeJS.Platform;
  readonly companionExecutablePath: string | null;
  readonly configurationPath?: string;
  readonly spawn?: DesktopJarvisVoiceHelperSpawn;
  readonly readinessTimeoutMs?: number;
}

export interface DesktopJarvisVoiceHelper {
  readonly getState: () => DesktopJarvisVoiceHelperState;
  readonly ensureRunning: (pairingUrl?: string) => Promise<DesktopJarvisVoiceHelperState>;
  readonly deliverPairingUrl: (pairingUrl: string) => Promise<boolean>;
  readonly stop: () => void;
}

function validPairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hashToken = new URLSearchParams(url.hash.slice(1)).get("token");
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.pathname.replace(/\/+$/u, "") === "/pair" &&
      ((url.searchParams.get("token") ?? "").trim().length > 0 ||
        (hashToken ?? "").trim().length > 0)
    );
  } catch {
    return false;
  }
}

function errorCodeFromOutput(line: string): string | null {
  if (!line.startsWith(managedErrorPrefix)) return null;
  return line.slice(managedErrorPrefix.length).trim().split(/\s+/u)[0] || "UNKNOWN";
}

function toOutputText(chunk: unknown): string {
  return typeof chunk === "string"
    ? chunk
    : Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
}

function handoffPairingUrl(
  child: DesktopJarvisVoiceHelperProcess,
  pairingUrl: string | undefined,
): void {
  // Always close stdin: the managed Companion uses EOF to finish its bounded
  // one-shot read. The URL never appears in argv or diagnostic output.
  if (pairingUrl !== undefined && child.stdin !== null && child.stdin !== undefined) {
    child.stdin.write(`${pairingUrl}\n`);
  }
  child.stdin?.end();
}

export function createDesktopJarvisVoiceHelper(
  input: CreateDesktopJarvisVoiceHelperInput,
): DesktopJarvisVoiceHelper {
  const executablePath = input.companionExecutablePath;
  const spawn =
    input.spawn ??
    ((path, args, options) =>
      NodeChildProcess.spawn(path, [...args], {
        stdio: options.stdio,
        windowsHide: options.windowsHide,
      }) as unknown as DesktopJarvisVoiceHelperProcess);
  const readinessTimeoutMs = input.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  let configured = readConfigured(input.configurationPath);
  const stateFor = (
    status: DesktopJarvisVoiceHelperStatus,
    errorCode?: string,
  ): DesktopJarvisVoiceHelperState => ({
    status,
    executablePath,
    configured,
    ...(errorCode === undefined ? {} : { errorCode }),
  });
  let state: DesktopJarvisVoiceHelperState = {
    status: executablePath === null ? "unavailable" : "installed",
    executablePath,
    configured,
  };
  let ownedProcess: DesktopJarvisVoiceHelperProcess | null = null;
  let readinessPromise: Promise<DesktopJarvisVoiceHelperState> | null = null;
  let deliveredPairingUrl: string | null = null;

  const setState = (next: DesktopJarvisVoiceHelperState) => {
    state = next;
  };

  const waitForReadiness = (
    child: DesktopJarvisVoiceHelperProcess,
  ): Promise<DesktopJarvisVoiceHelperState> =>
    new Promise((resolve) => {
      let settled = false;
      let output = "";
      const fail = (errorCode: string) => {
        if (ownedProcess === child) {
          ownedProcess = null;
          child.kill("SIGTERM");
          setState(stateFor("error", errorCode));
        }
        finish(stateFor("error", errorCode));
      };
      const finish = (next: DesktopJarvisVoiceHelperState) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(next);
      };
      const processOutput = (chunk: unknown) => {
        output += toOutputText(chunk);
        const lines = output.split(/\r?\n/u);
        output = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith(managedReadyPrefix)) {
            finish(stateFor(configured ? "configured" : "running"));
            continue;
          }
          if (trimmed === managedPairedPrefix) {
            configured = true;
            persistConfigured(input.configurationPath);
            if (settled) {
              setState(stateFor("configured"));
            }
            finish(stateFor("configured"));
            continue;
          }
          const errorCode = errorCodeFromOutput(trimmed);
          if (errorCode !== null) {
            fail(errorCode);
          }
        }
      };
      child.stdout?.on("data", processOutput);
      child.stderr?.on("data", processOutput);
      child.once("error", () => {
        fail("SPAWN_ERROR");
      });
      child.once("exit", () => {
        if (ownedProcess === child) {
          ownedProcess = null;
          setState(stateFor("error", "CHILD_EXITED"));
        }
        finish(stateFor("error", "CHILD_EXITED"));
      });
      const timeout = setTimeout(() => {
        fail("READINESS_TIMEOUT");
      }, readinessTimeoutMs);
    });

  const ensureRunning = async (pairingUrl?: string): Promise<DesktopJarvisVoiceHelperState> => {
    if (executablePath === null) return state;
    if (ownedProcess !== null && (state.status === "running" || state.status === "configured")) {
      if (pairingUrl !== undefined) await deliverPairingUrl(pairingUrl);
      return state;
    }
    if (readinessPromise !== null) {
      const ready = await readinessPromise;
      if (
        pairingUrl !== undefined &&
        (ready.status === "running" || ready.status === "configured")
      ) {
        await deliverPairingUrl(pairingUrl);
      }
      return state;
    }

    let child: DesktopJarvisVoiceHelperProcess;
    try {
      const args = ["--jarvis-managed"];
      if (pairingUrl !== undefined && validPairingUrl(pairingUrl)) {
        deliveredPairingUrl = pairingUrl;
      }
      child = spawn(executablePath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      handoffPairingUrl(child, pairingUrl);
    } catch {
      setState(stateFor("error", "SPAWN_ERROR"));
      return state;
    }
    ownedProcess = child;
    setState(stateFor("starting"));
    readinessPromise = waitForReadiness(child).then((next) => {
      setState(next);
      readinessPromise = null;
      return next;
    });
    return readinessPromise;
  };

  const deliverPairingUrl = async (pairingUrl: string): Promise<boolean> => {
    if (!validPairingUrl(pairingUrl) || executablePath === null) return false;
    const running = await ensureRunning();
    if (running.status !== "running" && running.status !== "configured") return false;
    if (deliveredPairingUrl === pairingUrl) return false;
    deliveredPairingUrl = pairingUrl;
    try {
      const messenger = spawn(executablePath, ["--jarvis-managed"], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      handoffPairingUrl(messenger, pairingUrl);
      messenger.once("error", () => {
        if (deliveredPairingUrl === pairingUrl) deliveredPairingUrl = null;
      });
      return true;
    } catch {
      deliveredPairingUrl = null;
      return false;
    }
  };

  return {
    getState: () => state,
    ensureRunning,
    deliverPairingUrl,
    stop: () => {
      const child = ownedProcess;
      ownedProcess = null;
      readinessPromise = null;
      if (child !== null) child.kill("SIGTERM");
      if (executablePath !== null) setState(stateFor("installed"));
    },
  };
}

export class DesktopJarvisVoiceHelperService extends Context.Service<
  DesktopJarvisVoiceHelperService,
  DesktopJarvisVoiceHelper
>()("@t3tools/desktop/app/DesktopJarvisVoiceHelper/DesktopJarvisVoiceHelperService") {}

export const layer = Layer.effect(
  DesktopJarvisVoiceHelperService,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const companionExecutablePath = environment.isPackaged
      ? resolveDesktopJarvisCompanionExecutable({
          platform: environment.platform,
          desktopExecutablePath: process.execPath,
          resourcesPath: environment.resourcesPath,
        })
      : null;
    const helper = createDesktopJarvisVoiceHelper({
      platform: environment.platform,
      companionExecutablePath,
      configurationPath: NodePath.join(environment.stateDir, "jarvis-voice-helper.json"),
    });
    return helper;
  }),
);
