import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

import { playNativeCue } from "./desktop-native-voice.ts";

type FakeStderr = NodeEvents.EventEmitter & {
  removeListener: NodeEvents.EventEmitter["removeListener"];
};
type FakeChild = NodeEvents.EventEmitter & {
  killed: boolean;
  kill: () => boolean;
  stderr: FakeStderr;
};

const spawned = vi.hoisted(() => ({ children: [] as Array<FakeChild> }));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new NodeEvents.EventEmitter() as FakeChild;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    child.stderr = new NodeEvents.EventEmitter() as FakeStderr;
    spawned.children.push(child);
    return child;
  }),
}));

describe("playNativeCue on Windows", () => {
  it("drains PowerShell stderr and reports it on failure", async () => {
    spawned.children.length = 0;
    const pending = playNativeCue("C:\\cue.wav", "win32");
    await Promise.resolve();
    await Promise.resolve();
    expect(spawned.children).toHaveLength(1);
    const child = spawned.children[0]!;

    // The piped stderr must have a drain attached while the child runs.
    expect(child.stderr.listenerCount("data")).toBeGreaterThan(0);
    child.stderr.emit("data", "Access is denied");
    child.emit("exit", 1, null);

    await expect(pending).rejects.toThrow("Access is denied");
    expect(child.stderr.listenerCount("data")).toBe(0);
  });
});
