import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type NativeSpeechProcess,
  type NativeSpeechProcessDependencies,
  playNativeCue,
  terminateNativeSpeechProcess,
} from "./desktop-native-voice.ts";

type FakeStderr = NodeEvents.EventEmitter & {
  removeListener: NodeEvents.EventEmitter["removeListener"];
};
type FakeChild = NodeEvents.EventEmitter & {
  killed: boolean;
  kill: () => boolean;
  stderr: FakeStderr;
};

function fakeChild(): FakeChild {
  const child = new NodeEvents.EventEmitter() as FakeChild;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.stderr = new NodeEvents.EventEmitter() as FakeStderr;
  return child;
}

function fakeDependencies(children: FakeChild[]): NativeSpeechProcessDependencies {
  return {
    spawn: (_command, _args) => {
      const child = fakeChild();
      children.push(child);
      return child as unknown as NativeSpeechProcess;
    },
  };
}

describe("playNativeCue on Windows", () => {
  it("drains PowerShell stderr and reports it on failure", async () => {
    const children: FakeChild[] = [];
    const pending = playNativeCue("C:\\cue.wav", "win32", undefined, fakeDependencies(children));
    await Promise.resolve();
    await Promise.resolve();
    expect(children).toHaveLength(1);
    const child = children[0]!;

    // The piped stderr must have a drain attached while the child runs.
    expect(child.stderr.listenerCount("data")).toBeGreaterThan(0);
    child.stderr.emit("data", "Access is denied");
    child.emit("exit", 1, null);

    await expect(pending).rejects.toThrow("Access is denied");
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  it("aborts through the injected spawn instead of module state", async () => {
    const children: FakeChild[] = [];
    const controller = new AbortController();
    const pending = playNativeCue(
      "C:\\cue.wav",
      "win32",
      controller.signal,
      fakeDependencies(children),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(children).toHaveLength(1);
    controller.abort();
    await pending;
    expect(children[0]?.killed).toBe(true);
  });
});

describe("terminateNativeSpeechProcess", () => {
  it("resolves through the bounded fallback when the child never settles", async () => {
    const child = fakeChild();
    let fallback: (() => void) | undefined;
    const timers = {
      setTimeout: (callback: () => void) => {
        fallback = callback;
        return "fallback-timer";
      },
      clearTimeout: vi.fn(),
    };
    let resolved = false;
    const pending = terminateNativeSpeechProcess(
      child as unknown as NativeSpeechProcess,
      timers,
    ).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    fallback?.();
    await pending;
    expect(resolved).toBe(true);
  });

  it("clears the fallback once the child exits", async () => {
    const child = fakeChild();
    const clearTimeout = vi.fn();
    const pending = terminateNativeSpeechProcess(child as unknown as NativeSpeechProcess, {
      setTimeout: () => "fallback-timer",
      clearTimeout,
    });
    child.emit("exit", 0, null);
    await pending;
    expect(clearTimeout).toHaveBeenCalledWith("fallback-timer");
  });
});
