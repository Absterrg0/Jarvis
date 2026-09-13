import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopUseAction, DesktopUseFrame, DesktopUseStatus } from "./desktopUse.ts";

const decodeAction = Schema.decodeUnknownSync(DesktopUseAction);
const encodeFrame = Schema.encodeSync(DesktopUseFrame);
const decodeFrame = Schema.decodeUnknownSync(DesktopUseFrame);
const decodeStatus = Schema.decodeUnknownSync(DesktopUseStatus);

describe("DesktopUseAction", () => {
  it("decodes every action variant", () => {
    expect(decodeAction({ type: "pointer.move", x: 1, y: 2 })).toEqual({
      type: "pointer.move",
      x: 1,
      y: 2,
    });
    expect(decodeAction({ type: "pointer.click", button: "right", count: 2 })).toEqual({
      type: "pointer.click",
      button: "right",
      count: 2,
    });
    expect(decodeAction({ type: "keyboard.key", key: "enter", modifiers: ["control"] })).toEqual({
      type: "keyboard.key",
      key: "enter",
      modifiers: ["control"],
    });
    expect(decodeAction({ type: "keyboard.type", text: "hi" })).toEqual({
      type: "keyboard.type",
      text: "hi",
    });
    expect(decodeAction({ type: "window.focus", windowId: "0x1" })).toEqual({
      type: "window.focus",
      windowId: "0x1",
    });
  });

  it("rejects an unknown action type", () => {
    expect(() => decodeAction({ type: "pointer.teleport", x: 1, y: 2 })).toThrow();
  });
});

describe("DesktopUseFrame", () => {
  it("round-trips through encode and decode", () => {
    const frame = {
      displayId: "eDP-1",
      width: 2560,
      height: 1440,
      scale: 2,
      mimeType: "image/png" as const,
      data: "AAAA",
      capturedAt: 1_700_000_000_000,
      cursor: { x: 4, y: 8 },
    };
    const encoded = encodeFrame(frame);
    expect(decodeFrame(encoded)).toEqual(frame);
  });
});

describe("DesktopUseStatus", () => {
  it("decodes an unavailable status without displays", () => {
    const status = {
      available: false,
      platform: "linux",
      backend: "linux-wayland",
      reason: "No Wayland capture tool found.",
      displays: [],
      supports: { capture: false, pointer: false, keyboard: false, windows: false },
    } as const;
    expect(decodeStatus(status)).toEqual(status);
  });
});
