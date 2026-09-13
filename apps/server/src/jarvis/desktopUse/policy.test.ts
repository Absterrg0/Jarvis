import type { DesktopUseAction } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkRateLimit,
  DESKTOP_USE_MIN_ACTION_INTERVAL_MS,
  isAllowedKey,
  resolveDisplay,
  validateDesktopUseAction,
} from "./policy.ts";

describe("validateDesktopUseAction", () => {
  it("accepts ordinary pointer and keyboard actions", () => {
    const actions: ReadonlyArray<DesktopUseAction> = [
      { type: "pointer.move", x: 100, y: 200 },
      { type: "pointer.click", x: 1, y: 2, count: 2 },
      { type: "pointer.click", button: "right" },
      { type: "pointer.drag", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
      { type: "pointer.scroll", deltaY: 240 },
      { type: "keyboard.type", text: "hello" },
      { type: "keyboard.key", key: "enter", modifiers: ["control"] },
      { type: "keyboard.key", key: "a" },
      { type: "window.focus", windowId: "0x1" },
    ];
    for (const action of actions) {
      expect(validateDesktopUseAction(action)).toBeNull();
    }
  });

  it("rejects out-of-range coordinates", () => {
    expect(validateDesktopUseAction({ type: "pointer.move", x: 1e9, y: 0 })).not.toBeNull();
    expect(
      validateDesktopUseAction({
        type: "pointer.drag",
        from: { x: 0, y: 0 },
        to: { x: 0, y: Number.NaN },
      }),
    ).not.toBeNull();
  });

  it("rejects empty or unbounded scroll and oversized text", () => {
    expect(
      validateDesktopUseAction({ type: "pointer.scroll", deltaX: 0, deltaY: 0 }),
    ).not.toBeNull();
    expect(validateDesktopUseAction({ type: "pointer.scroll", deltaY: 1e9 })).not.toBeNull();
    expect(
      validateDesktopUseAction({ type: "keyboard.type", text: "x".repeat(5000) }),
    ).not.toBeNull();
  });

  it("rejects unknown keys but allows named and single-character keys", () => {
    expect(validateDesktopUseAction({ type: "keyboard.key", key: "not-a-key" })).not.toBeNull();
    expect(validateDesktopUseAction({ type: "keyboard.key", key: "pageup" })).toBeNull();
    expect(validateDesktopUseAction({ type: "keyboard.key", key: "7" })).toBeNull();
  });
});

describe("isAllowedKey", () => {
  it("accepts named keys case-insensitively and printable characters", () => {
    expect(isAllowedKey("Enter")).toBe(true);
    expect(isAllowedKey("F5")).toBe(true);
    expect(isAllowedKey("é")).toBe(true);
    expect(isAllowedKey("multi")).toBe(false);
    expect(isAllowedKey("\u0000")).toBe(false);
  });
});

describe("checkRateLimit", () => {
  it("refuses actions that arrive too fast and then recovers", () => {
    const first = checkRateLimit({ lastActionAt: 0 }, 1_000);
    expect(first.reason).toBeNull();
    const tooSoon = checkRateLimit(first.next, 1_000 + DESKTOP_USE_MIN_ACTION_INTERVAL_MS - 1);
    expect(tooSoon.reason).not.toBeNull();
    const later = checkRateLimit(first.next, 1_000 + DESKTOP_USE_MIN_ACTION_INTERVAL_MS);
    expect(later.reason).toBeNull();
  });
});

describe("resolveDisplay", () => {
  const displays = [
    { id: "a", x: 0, y: 0, width: 100, height: 100, scale: 1, primary: false },
    { id: "b", x: 100, y: 0, width: 100, height: 100, scale: 1, primary: true },
  ];

  it("prefers the named display then the primary", () => {
    expect(resolveDisplay(displays, "a")?.id).toBe("a");
    expect(resolveDisplay(displays, undefined)?.id).toBe("b");
    expect(resolveDisplay([displays[0]!], undefined)?.id).toBe("a");
    expect(resolveDisplay([], "missing")).toBeUndefined();
  });
});
