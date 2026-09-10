import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  attachDesktopPushToTalkHook,
  desktopPushToTalkKeys,
  type DesktopPushToTalkHook,
} from "./DesktopPushToTalk.ts";

describe("DesktopPushToTalk", () => {
  it("coalesces Linux auto-repeat key pairs into one physical hold", () => {
    const listeners = new Map<string, (event: never) => void>();
    const hook: DesktopPushToTalkHook = {
      on: vi.fn((type, listener) => listeners.set(type, listener as (event: never) => void)),
      removeListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const pressed = vi.fn();
    const released = vi.fn();
    const detach = attachDesktopPushToTalkHook({ hook, onPressed: pressed, onReleased: released });
    const keydown = listeners.get("keydown");
    const keyup = listeners.get("keyup");
    const repeatedJ = { keycode: desktopPushToTalkKeys.j, ctrlKey: true, shiftKey: true };

    for (let repeat = 0; repeat < 11; repeat += 1) {
      keydown?.(repeatedJ as never);
      keyup?.(repeatedJ as never);
    }
    keyup?.({ keycode: desktopPushToTalkKeys.shift, ctrlKey: true, shiftKey: false } as never);

    expect(pressed).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
    detach();
  });

  it("starts once, releases on a modifier keyup, and ignores repeats", () => {
    const listeners = new Map<string, (event: never) => void>();
    const hook: DesktopPushToTalkHook = {
      on: vi.fn((type, listener) => listeners.set(type, listener as (event: never) => void)),
      removeListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const pressed = vi.fn();
    const released = vi.fn();
    const detach = attachDesktopPushToTalkHook({ hook, onPressed: pressed, onReleased: released });
    const keydown = listeners.get("keydown");
    const keyup = listeners.get("keyup");
    const heldJ = { keycode: desktopPushToTalkKeys.j, ctrlKey: true, shiftKey: true };

    keydown?.(heldJ as never);
    keydown?.(heldJ as never);
    keyup?.(heldJ as never);
    keyup?.(heldJ as never);
    keyup?.({ keycode: desktopPushToTalkKeys.control, ctrlKey: false, shiftKey: true } as never);
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
    detach();
  });

  it("releases on J keyup on Windows where that edge is physical", () => {
    const listeners = new Map<string, (event: never) => void>();
    const hook: DesktopPushToTalkHook = {
      on: vi.fn((type, listener) => listeners.set(type, listener as (event: never) => void)),
      removeListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const released = vi.fn();
    const detach = attachDesktopPushToTalkHook({
      hook,
      releaseOnJ: true,
      onPressed: vi.fn(),
      onReleased: released,
    });
    const heldJ = { keycode: desktopPushToTalkKeys.j, ctrlKey: true, shiftKey: true };

    listeners.get("keydown")?.(heldJ as never);
    listeners.get("keyup")?.(heldJ as never);

    expect(released).toHaveBeenCalledTimes(1);
    detach();
  });

  it("releases an active capture during idempotent disposal and ignores stale events", () => {
    const listeners = new Map<string, (event: never) => void>();
    const hook: DesktopPushToTalkHook = {
      on: vi.fn((type, listener) => listeners.set(type, listener as (event: never) => void)),
      removeListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const released = vi.fn();
    const detach = attachDesktopPushToTalkHook({
      hook,
      onPressed: vi.fn(),
      onReleased: released,
    });
    listeners.get("keydown")?.({
      keycode: desktopPushToTalkKeys.j,
      ctrlKey: true,
      shiftKey: true,
    } as never);
    detach();
    detach();
    listeners.get("keyup")?.({
      keycode: desktopPushToTalkKeys.j,
      ctrlKey: true,
      shiftKey: true,
    } as never);
    expect(released).toHaveBeenCalledTimes(1);
    expect(hook.stop).toHaveBeenCalledTimes(1);
  });
});
