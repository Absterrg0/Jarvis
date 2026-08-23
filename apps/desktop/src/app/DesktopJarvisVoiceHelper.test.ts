// @effect-diagnostics nodeBuiltinImport:off

import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeEvents from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopJarvisVoiceHelper,
  resolveDesktopJarvisCompanionExecutable,
  type DesktopJarvisVoiceHelperProcess,
} from "./DesktopJarvisVoiceHelper.ts";

class FakeProcess extends NodeEvents.EventEmitter implements DesktopJarvisVoiceHelperProcess {
  readonly stdin = { write: vi.fn(() => true), end: vi.fn() };
  readonly stdout = new NodeEvents.EventEmitter();
  readonly stderr = new NodeEvents.EventEmitter();
  readonly kill = vi.fn(() => true);
  readonly pid = 42;
}

function emitStdout(process: FakeProcess, line: string) {
  process.stdout.emit("data", Buffer.from(`${line}\n`));
}

describe("DesktopJarvisVoiceHelper", () => {
  it("resolves the packaged companion beside the desktop payload and Linux resources", () => {
    const windowsRoot = "C:\\Users\\julius\\AppData\\Local\\Programs\\Jarvis";
    expect(
      resolveDesktopJarvisCompanionExecutable({
        platform: "win32",
        desktopExecutablePath: NodePath.win32.join(windowsRoot, "desktop", "Jarvis.exe"),
        exists: (path) => path.endsWith("companion\\Jarvis Companion.exe"),
      }),
    ).toBe(NodePath.win32.join(windowsRoot, "companion", "Jarvis Companion.exe"));

    const linuxRoot = NodePath.posix.join("/opt", "jarvis");
    const linuxCompanion = NodePath.posix.join(linuxRoot, "companion", "jarvis-companion");
    expect(
      resolveDesktopJarvisCompanionExecutable({
        platform: "linux",
        desktopExecutablePath: NodePath.posix.join(linuxRoot, "desktop", "Jarvis"),
        exists: (path) => path === linuxCompanion,
      }),
    ).toBe(linuxCompanion);

    const appImageResources = "/tmp/.mount_jarvis/resources";
    const appImageCompanion = NodePath.posix.join(
      appImageResources,
      "companion",
      "jarvis-companion",
    );
    expect(
      resolveDesktopJarvisCompanionExecutable({
        platform: "linux",
        desktopExecutablePath: "/tmp/.mount_jarvis/jarvis",
        resourcesPath: appImageResources,
        exists: (path) => path === appImageCompanion,
      }),
    ).toBe(appImageCompanion);
  });

  it("reuses one captured process instead of spawning duplicate helpers", async () => {
    const child = new FakeProcess();
    const spawn = vi.fn(() => child);
    const helper = createDesktopJarvisVoiceHelper({
      platform: "win32",
      companionExecutablePath: "C:\\Jarvis\\companion\\Jarvis Companion.exe",
      spawn,
      readinessTimeoutMs: 50,
    });

    const first = helper.ensureRunning();
    emitStdout(child, "JARVIS_MANAGED_READY");
    await expect(first).resolves.toMatchObject({ status: "running" });
    await expect(helper.ensureRunning()).resolves.toMatchObject({ status: "running" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "C:\\Jarvis\\companion\\Jarvis Companion.exe",
      ["--jarvis-managed"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("reports bounded readiness timeout and managed failure output", async () => {
    const timeoutChild = new FakeProcess();
    const timeoutHelper = createDesktopJarvisVoiceHelper({
      platform: "linux",
      companionExecutablePath: "/opt/jarvis/companion/jarvis-companion",
      spawn: () => timeoutChild,
      readinessTimeoutMs: 5,
    });
    await expect(timeoutHelper.ensureRunning()).resolves.toMatchObject({
      status: "error",
      errorCode: "READINESS_TIMEOUT",
    });
    expect(timeoutChild.kill).toHaveBeenCalledWith("SIGTERM");

    const failedChild = new FakeProcess();
    const failedHelper = createDesktopJarvisVoiceHelper({
      platform: "linux",
      companionExecutablePath: "/opt/jarvis/companion/jarvis-companion",
      spawn: () => failedChild,
      readinessTimeoutMs: 50,
    });
    const pending = failedHelper.ensureRunning();
    emitStdout(failedChild, "JARVIS_MANAGED_ERROR PAIRING_REJECTED");
    await expect(pending).resolves.toMatchObject({
      status: "error",
      errorCode: "PAIRING_REJECTED",
    });
  });

  it("hands a pairing URL to the existing managed instance once", async () => {
    const child = new FakeProcess();
    const spawn = vi.fn(() => child);
    const helper = createDesktopJarvisVoiceHelper({
      platform: "win32",
      companionExecutablePath: "C:\\Jarvis\\companion\\Jarvis Companion.exe",
      spawn,
      readinessTimeoutMs: 50,
    });
    const running = helper.ensureRunning();
    emitStdout(child, "JARVIS_MANAGED_READY");
    await running;

    await expect(helper.deliverPairingUrl("http://127.0.0.1:3773/pair#token=one")).resolves.toBe(
      true,
    );
    await expect(helper.deliverPairingUrl("http://127.0.0.1:3773/pair#token=one")).resolves.toBe(
      false,
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenLastCalledWith(
      "C:\\Jarvis\\companion\\Jarvis Companion.exe",
      ["--jarvis-managed"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(child.stdin.write).toHaveBeenCalledWith("http://127.0.0.1:3773/pair#token=one\n");
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("token=one");
  });

  it("hands initial pairing through stdin without exposing it in argv", async () => {
    const child = new FakeProcess();
    const spawn = vi.fn(() => child);
    const helper = createDesktopJarvisVoiceHelper({
      platform: "linux",
      companionExecutablePath: "/opt/jarvis/companion/jarvis-companion",
      spawn,
      readinessTimeoutMs: 50,
    });
    const running = helper.ensureRunning("http://127.0.0.1:3773/pair#token=initial");
    emitStdout(child, "JARVIS_MANAGED_READY");
    await expect(running).resolves.toMatchObject({ status: "running" });
    expect(spawn).toHaveBeenCalledWith(
      "/opt/jarvis/companion/jarvis-companion",
      ["--jarvis-managed"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(child.stdin.write).toHaveBeenCalledWith("http://127.0.0.1:3773/pair#token=initial\n");
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("token=initial");
  });

  it("replaces the owned process after it exits instead of reporting stale readiness", async () => {
    const firstChild = new FakeProcess();
    const secondChild = new FakeProcess();
    const spawned = [firstChild, secondChild];
    const spawn = vi.fn(() => spawned.shift()! as DesktopJarvisVoiceHelperProcess);
    const helper = createDesktopJarvisVoiceHelper({
      platform: "linux",
      companionExecutablePath: "/opt/jarvis/companion/jarvis-companion",
      spawn,
      readinessTimeoutMs: 50,
    });

    const first = helper.ensureRunning();
    emitStdout(firstChild, "JARVIS_MANAGED_READY");
    await expect(first).resolves.toMatchObject({ status: "running" });
    firstChild.emit("exit", 0, null);
    expect(helper.getState()).toMatchObject({ status: "error", errorCode: "CHILD_EXITED" });

    const second = helper.ensureRunning();
    emitStdout(secondChild, "JARVIS_MANAGED_READY");
    await expect(second).resolves.toMatchObject({ status: "running" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("persists only the sanitized managed paired status, never the pairing URL", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jarvis-voice-helper-"));
    const configurationPath = NodePath.join(root, "voice-helper.json");
    try {
      const child = new FakeProcess();
      const helper = createDesktopJarvisVoiceHelper({
        platform: "linux",
        companionExecutablePath: "/opt/jarvis/companion/jarvis-companion",
        configurationPath,
        spawn: () => child,
        readinessTimeoutMs: 50,
      });
      const pending = helper.ensureRunning("http://127.0.0.1:3773/pair#token=secret");
      emitStdout(child, "JARVIS_MANAGED_READY");
      await pending;
      emitStdout(child, "JARVIS_MANAGED_PAIRED");
      expect(helper.getState()).toMatchObject({ status: "configured", configured: true });
      expect(NodeFS.readFileSync(configurationPath, "utf8")).toBe('{"configured":true}\n');
      expect(NodeFS.readFileSync(configurationPath, "utf8")).not.toContain("secret");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles an asynchronous second-instance messenger error without an unhandled crash", async () => {
    const child = new FakeProcess();
    const messenger = new FakeProcess();
    const retryMessenger = new FakeProcess();
    const spawned = [child, messenger, retryMessenger];
    const spawn = vi.fn(() => spawned.shift()! as DesktopJarvisVoiceHelperProcess);
    const helper = createDesktopJarvisVoiceHelper({
      platform: "win32",
      companionExecutablePath: "C:\\Jarvis\\companion\\Jarvis Companion.exe",
      spawn,
      readinessTimeoutMs: 50,
    });
    const running = helper.ensureRunning();
    emitStdout(child, "JARVIS_MANAGED_READY");
    await running;
    await expect(helper.deliverPairingUrl("http://127.0.0.1:3773/pair#token=one")).resolves.toBe(
      true,
    );
    messenger.emit("error", new Error("one-shot launch failed"));
    await expect(helper.deliverPairingUrl("http://127.0.0.1:3773/pair#token=one")).resolves.toBe(
      true,
    );
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});
