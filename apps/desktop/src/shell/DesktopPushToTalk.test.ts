import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  attachDesktopPushToTalkHook,
  desktopPushToTalkKeys,
  type DesktopPushToTalkHook,
} from "./DesktopPushToTalk.ts";

describe("DesktopPushToTalk", () => {
  it("starts once, releases on either keyup, and ignores repeats", () => {
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
    expect(pressed).toHaveBeenCalledTimes(1);
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
