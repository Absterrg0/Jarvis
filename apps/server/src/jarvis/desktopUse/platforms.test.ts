import { describe, expect, it } from "vite-plus/test";
import {
  buildCaptureCommands,
  buildNativeDragCommand,
  buildKeyboardCommands,
  buildPointerCommands,
  buildKeyboardReleaseCommands,
  buildFocusWindowCommand,
  detectDisplayServer,
  resolveBackend,
  encodePowerShell,
  type DesktopTooling,
} from "./platforms.ts";
import { validateDesktopUseAction } from "./policy.ts";
const x11: DesktopTooling = {
  platform: "linux",
  backend: "linux-x11",
  tools: new Set(["xdotool", "import", "ffmpeg"]),
  xDisplay: ":7",
};
const wayland: DesktopTooling = {
  platform: "linux",
  backend: "linux-wayland",
  tools: new Set(["ydotool", "wtype", "grim"]),
};
const windows: DesktopTooling = {
  platform: "win32",
  backend: "windows",
  tools: new Set(["powershell"]),
};
const mac: DesktopTooling = {
  platform: "darwin",
  backend: "macos",
  tools: new Set(["osascript", "screencapture"]),
};
const display = { id: "DP-1", x: -100, y: 20, width: 100, height: 80, scale: 2, primary: false };
const script = (command: { args: ReadonlyArray<string> }) =>
  Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");

describe("native platform contracts", () => {
  it("requires a graphical session on Linux", () => {
    expect(resolveBackend({ platform: "linux", displayServer: null })).toBe("unavailable");
    expect(detectDisplayServer({ DISPLAY: ":7" })).toBe("x11");
    expect(detectDisplayServer({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" })).toBe("wayland");
  });
  it("keeps X session identity separate from monitor identity", () => {
    const commands = buildCaptureCommands(x11, { outPath: "shot.png", display });
    expect(commands.at(-1)?.args).toContain(":7");
    expect(commands.at(-1)?.args).not.toContain(":0.0");
  });
  it("selects named grim outputs and excludes blank XWayland fallbacks", () => {
    expect(buildCaptureCommands(wayland, { outPath: "shot.png", display })[0]?.args).toEqual([
      "-o",
      "DP-1",
      "-s",
      "2",
      "shot.png",
    ]);
    expect(
      buildCaptureCommands(
        { ...wayland, tools: new Set(["import", "ffmpeg"]) },
        { outPath: "shot.png" },
      ),
    ).toEqual([]);
  });
  it("presses Wayland modifiers around the key and releases in reverse", () => {
    expect(
      buildKeyboardCommands(wayland, {
        type: "keyboard.key",
        key: "c",
        modifiers: ["control", "shift"],
      })[0]?.args,
    ).toEqual(["-M", "ctrl", "-M", "shift", "-k", "U63", "-m", "shift", "-m", "ctrl"]);
  });
  it("supports ydotool-only Enter and shortcuts", () => {
    const tools = { ...wayland, tools: new Set<"ydotool">(["ydotool"]) };
    expect(buildKeyboardCommands(tools, { type: "keyboard.key", key: "enter" })[0]?.args).toEqual([
      "key",
      "28:1",
      "28:0",
    ]);
    expect(
      buildKeyboardCommands(tools, { type: "keyboard.key", key: "c", modifiers: ["control"] })[0]
        ?.args,
    ).toEqual(["key", "29:1", "46:1", "46:0", "29:0"]);
  });
  it("types literal backslashes with bounded ydotool pacing", () => {
    const tools = { ...wayland, tools: new Set<"ydotool">(["ydotool"]) };
    const text = String.raw`C:\new\test`;
    expect(buildKeyboardCommands(tools, { type: "keyboard.type", text })[0]?.args).toEqual([
      "type",
      "--escape",
      "0",
      "--key-delay",
      "0",
      "--key-hold",
      "0",
      "--",
      text,
    ]);
  });
  it("uses button masks and real wheel events", () => {
    expect(buildPointerCommands(wayland, { type: "pointer.down" })[0]?.args).toEqual([
      "click",
      "0x40",
    ]);
    expect(buildPointerCommands(wayland, { type: "pointer.up", button: "right" })[0]?.args).toEqual(
      ["click", "0x81"],
    );
    expect(
      buildPointerCommands(wayland, { type: "pointer.scroll", deltaY: 120, deltaX: -100 })[0]?.args,
    ).toEqual(["mousemove", "--wheel", "-x", "-1", "-y", "-1"]);
  });
  it("does not use unsupported xdotool movement flags", () => {
    expect(buildPointerCommands(x11, { type: "pointer.move", x: 5, y: 6 })[0]?.args).toEqual([
      "mousemove",
      "5",
      "6",
    ]);
  });
  it("uses system keyboard actions on macOS even without external helpers", () => {
    expect(buildKeyboardCommands(mac, { type: "keyboard.key", key: "enter" })[0]?.args).toEqual([
      "-e",
      'tell application "System Events" to key code 36',
    ]);
    expect(
      buildKeyboardCommands(mac, { type: "keyboard.key", key: "c", modifiers: ["meta"] })[0]
        ?.args[1],
    ).toContain('keystroke "c" using {command down}');
  });
  it("implements current-position clicks, signed coordinates and scroll on macOS", () => {
    expect(buildPointerCommands(mac, { type: "pointer.click" })[0]?.args.at(-1)).toContain(
      "position.x",
    );
    expect(
      buildPointerCommands(mac, { type: "pointer.move", x: -20, y: 10 })[0]?.args.at(-1),
    ).toContain("var x=-20,y=10");
    expect(
      buildPointerCommands(mac, { type: "pointer.scroll", deltaY: 100 })[0]?.args.at(-1),
    ).toContain("CGEventCreateScrollWheelEvent");
  });
  it("preserves PowerShell here-strings and literal text semantics", () => {
    const click = script(buildPointerCommands(windows, { type: "pointer.click", x: 1, y: 1 })[0]!);
    expect(click).toMatch(/@'\r?\n/);
    expect(click).toMatch(/\r?\n'@\r?\n/);
    const text = script(
      buildKeyboardCommands(windows, { type: "keyboard.type", text: "aAé🙂" })[0]!,
    );
    expect(text).toContain("SendInput");
    expect(text).toContain("KeyEvent(0,ch,4)");
    expect(text).not.toContain("Keys]::Parse");
    expect(
      script(
        buildKeyboardCommands(windows, {
          type: "keyboard.key",
          key: "a",
          modifiers: ["control"],
        })[0]!,
      ),
    ).toContain("VkKeyScanEx");
  });
  it("Windows scrolling normalizes wheel amount and honors its target", () => {
    const code = script(
      buildPointerCommands(windows, {
        type: "pointer.scroll",
        x: 4,
        y: 5,
        deltaY: 120,
        deltaX: -100,
      })[0]!,
    );
    expect(code).toContain("[DesktopInput]::Move(4,5)");
    expect(code).toContain("[DesktopInput]::Wheel(-1,1)");
    expect(code).toContain("-vertical*120");
  });
  it("focuses exact window identities and supplies cancellation cleanup", () => {
    expect(buildFocusWindowCommand(mac, '{"pid":4,"title":"a"}')?.command).toBe(
      "/usr/bin/osascript",
    );
    expect(
      buildKeyboardReleaseCommands(wayland, {
        type: "keyboard.key",
        key: "c",
        modifiers: ["control"],
      }),
    ).toEqual([]);
  });
  it("bounds scroll coordinates and paired targets", () => {
    expect(
      validateDesktopUseAction({ type: "pointer.scroll", x: 1e9, y: 1, deltaY: 100 }),
    ).not.toBeNull();
    expect(validateDesktopUseAction({ type: "pointer.click", x: 1 })).not.toBeNull();
  });
  it("round trips PowerShell encoded strings", () => {
    expect(Buffer.from(encodePowerShell("'é🙂'"), "base64").toString("utf16le")).toBe("'é🙂'");
  });
});

it("bounds Windows command lines without truncating quoted Unicode text", () => {
  const text = "'🙂".repeat(1024);
  const commands = buildKeyboardCommands(windows, { type: "keyboard.type", text });
  expect(commands).toHaveLength(2);
  expect(commands.every((c) => c.args.join(" ").length < 30000)).toBe(true);
  expect(
    buildKeyboardReleaseCommands(windows, { type: "keyboard.type", text })[0]!.args.join(" ")
      .length,
  ).toBeLessThan(30000);
});
it("native drags stay in one helper and own their release", () => {
  const action = {
    type: "pointer.drag" as const,
    from: { x: 1, y: 2 },
    to: { x: 30, y: 40 },
    durationMs: 250,
  };
  expect(script(buildNativeDragCommand(windows, action)!)).toContain(
    "finally { [DesktopInput]::Button(0,$false)",
  );
  expect(buildNativeDragCommand(mac, action)?.args.at(-1)).toContain("finally { post(2); }");
});
