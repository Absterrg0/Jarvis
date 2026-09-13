import type { DesktopUseAction, DesktopUseBackend } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCaptureCommand,
  buildCaptureCommands,
  buildCursorCommand,
  buildDisplayGeometryCommand,
  buildFocusWindowCommand,
  buildKeyboardCommands,
  buildListWindowsCommand,
  buildPointerCommands,
  detectDisplayServer,
  encodePowerShell,
  resolveBackend,
  type DesktopToolName,
  type DesktopTooling,
} from "./platforms.ts";

const tooling = (
  backend: DesktopUseBackend,
  tools: ReadonlyArray<DesktopToolName>,
): DesktopTooling => ({
  platform: backend === "macos" ? "darwin" : backend === "windows" ? "win32" : "linux",
  backend,
  tools: new Set(tools),
});

describe("resolveBackend", () => {
  it("maps platforms and display servers", () => {
    expect(resolveBackend({ platform: "darwin", displayServer: null })).toBe("macos");
    expect(resolveBackend({ platform: "win32", displayServer: null })).toBe("windows");
    expect(resolveBackend({ platform: "linux", displayServer: "x11" })).toBe("linux-x11");
    expect(resolveBackend({ platform: "linux", displayServer: "wayland" })).toBe("linux-wayland");
    expect(resolveBackend({ platform: "linux", displayServer: null })).toBe("linux-x11");
    expect(resolveBackend({ platform: "freebsd", displayServer: null })).toBe("unavailable");
  });
});

describe("detectDisplayServer", () => {
  it("prefers explicit session type and falls back to env vars", () => {
    expect(detectDisplayServer({ XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
    expect(detectDisplayServer({ WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
    expect(detectDisplayServer({ XDG_SESSION_TYPE: "x11" })).toBe("x11");
    expect(detectDisplayServer({ DISPLAY: ":0" })).toBe("x11");
    expect(detectDisplayServer({})).toBeNull();
  });
});

describe("buildCaptureCommand", () => {
  it("uses ImageMagick on X11 when present", () => {
    const command = buildCaptureCommand(tooling("linux-x11", ["import", "scrot"]), {
      outPath: "/tmp/shot.png",
    });
    expect(command).toEqual({ command: "import", args: ["-window", "root", "/tmp/shot.png"] });
  });

  it("offers every present capture backend as a fallback", () => {
    const commands = buildCaptureCommands(tooling("linux-x11", ["import", "ffmpeg"]), {
      outPath: "/tmp/shot.png",
    });
    expect(commands.map((command) => command.command)).toEqual(["import", "ffmpeg"]);
  });

  it("falls back to scrot then ffmpeg", () => {
    expect(
      buildCaptureCommand(tooling("linux-x11", ["scrot"]), { outPath: "/tmp/shot.png" })?.command,
    ).toBe("scrot");
    const ffmpeg = buildCaptureCommand(tooling("linux-x11", ["ffmpeg"]), {
      outPath: "/tmp/shot.png",
    });
    expect(ffmpeg?.command).toBe("ffmpeg");
    expect(buildCaptureCommand(tooling("linux-x11", []), { outPath: "/tmp/shot.png" })).toBeNull();
  });

  it("uses grim on Wayland and reports null without a tool", () => {
    const grim = buildCaptureCommand(tooling("linux-wayland", ["grim"]), {
      outPath: "/tmp/shot.png",
    });
    expect(grim).toEqual({ command: "grim", args: ["/tmp/shot.png"] });
    expect(
      buildCaptureCommand(tooling("linux-wayland", []), { outPath: "/tmp/shot.png" }),
    ).toBeNull();
  });

  it("uses the absolute screencapture path on macOS, with a display index", () => {
    expect(
      buildCaptureCommand(tooling("macos", ["screencapture"]), {
        outPath: "/tmp/shot.png",
        display: "1",
      }),
    ).toEqual({
      command: "/usr/sbin/screencapture",
      args: ["-x", "-t", "png", "-D", "1", "/tmp/shot.png"],
    });
  });

  it("routes Windows capture through encoded PowerShell", () => {
    const command = buildCaptureCommand(tooling("windows", ["powershell"]), {
      outPath: "C:\\Temp\\shot.png",
    });
    expect(command?.command).toBe("powershell.exe");
    expect(command?.args).toContain("-EncodedCommand");
  });
});

describe("buildPointerCommands", () => {
  it("moves and clicks with xdotool", () => {
    const move: DesktopUseAction = { type: "pointer.move", x: 10, y: 20 };
    expect(buildPointerCommands(tooling("linux-x11", ["xdotool"]), move)).toEqual([
      { command: "xdotool", args: ["mousemove", "--sync", "10", "20"] },
    ]);
    const click: DesktopUseAction = { type: "pointer.click", x: 5, y: 6, count: 2 };
    expect(buildPointerCommands(tooling("linux-x11", ["xdotool"]), click)).toEqual([
      {
        command: "xdotool",
        args: ["mousemove", "--sync", "5", "6", "click", "--repeat", "2", "1"],
      },
    ]);
  });

  it("maps scroll direction to wheel buttons", () => {
    const down: DesktopUseAction = { type: "pointer.scroll", deltaY: 300 };
    expect(buildPointerCommands(tooling("linux-x11", ["xdotool"]), down)).toEqual([
      { command: "xdotool", args: ["click", "--repeat", "3", "5"] },
    ]);
    const up: DesktopUseAction = { type: "pointer.scroll", deltaY: -100 };
    expect(buildPointerCommands(tooling("linux-x11", ["xdotool"]), up)).toEqual([
      { command: "xdotool", args: ["click", "--repeat", "1", "4"] },
    ]);
  });

  it("emits a down/move/up sequence for drag on X11", () => {
    const drag: DesktopUseAction = {
      type: "pointer.drag",
      from: { x: 0, y: 0 },
      to: { x: 100, y: 50 },
      durationMs: 100,
    };
    const commands = buildPointerCommands(tooling("linux-x11", ["xdotool"]), drag);
    expect(commands.map((command) => command.args[0])).toEqual([
      "mousemove",
      "mousedown",
      "mousemove",
      "mouseup",
    ]);
  });

  it("uses cliclick single/double clicks on macOS", () => {
    const double: DesktopUseAction = { type: "pointer.click", x: 3, y: 4, count: 2 };
    expect(buildPointerCommands(tooling("macos", ["cliclick"]), double)).toEqual([
      { command: "cliclick", args: ["dc:3,4"] },
    ]);
    const right: DesktopUseAction = { type: "pointer.click", x: 3, y: 4, button: "right" };
    expect(buildPointerCommands(tooling("macos", ["cliclick"]), right)).toEqual([
      { command: "cliclick", args: ["rc:3,4"] },
    ]);
  });

  it("uses ydotool absolute moves on Wayland", () => {
    const move: DesktopUseAction = { type: "pointer.move", x: 7, y: 8 };
    expect(buildPointerCommands(tooling("linux-wayland", ["ydotool"]), move)).toEqual([
      { command: "ydotool", args: ["mousemove", "--absolute", "7", "8"] },
    ]);
  });

  it("encodes Windows pointer actions as PowerShell", () => {
    const click: DesktopUseAction = { type: "pointer.click", x: 1, y: 2 };
    const commands = buildPointerCommands(tooling("windows", ["powershell"]), click);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("powershell.exe");
  });
});

describe("buildKeyboardCommands", () => {
  it("maps named keys and modifiers for xdotool", () => {
    const action: DesktopUseAction = {
      type: "keyboard.key",
      key: "enter",
      modifiers: ["control", "shift"],
    };
    expect(buildKeyboardCommands(tooling("linux-x11", ["xdotool"]), action)).toEqual([
      { command: "xdotool", args: ["key", "--clearmodifiers", "ctrl+shift+Return"] },
    ]);
  });

  it("types text through xdotool and wtype", () => {
    const text: DesktopUseAction = { type: "keyboard.type", text: "hello world" };
    expect(buildKeyboardCommands(tooling("linux-x11", ["xdotool"]), text)).toEqual([
      {
        command: "xdotool",
        args: ["type", "--clearmodifiers", "--delay", "2", "--", "hello world"],
      },
    ]);
    expect(buildKeyboardCommands(tooling("linux-wayland", ["wtype"]), text)).toEqual([
      { command: "wtype", args: ["--", "hello world"] },
    ]);
  });

  it("falls back to AppleScript when cliclick is absent", () => {
    const action: DesktopUseAction = { type: "keyboard.key", key: "tab" };
    const commands = buildKeyboardCommands(tooling("macos", ["osascript"]), action);
    expect(commands).toEqual([
      {
        command: "/usr/bin/osascript",
        args: ["-e", 'tell application "System Events" to key code 48'],
      },
    ]);
  });

  it("uses cliclick key chords when available", () => {
    const action: DesktopUseAction = {
      type: "keyboard.key",
      key: "c",
      modifiers: ["meta"],
    };
    expect(buildKeyboardCommands(tooling("macos", ["cliclick"]), action)).toEqual([
      { command: "cliclick", args: ["kp:cmd+c"] },
    ]);
  });
});

describe("auxiliary commands", () => {
  it("reads the cursor where the platform exposes it", () => {
    expect(buildCursorCommand(tooling("linux-x11", ["xdotool"]))?.command).toBe("xdotool");
    expect(buildCursorCommand(tooling("linux-wayland", ["ydotool"]))).toBeNull();
    expect(buildCursorCommand(tooling("macos", ["cliclick"]))?.command).toBe("cliclick");
  });

  it("lists windows only where a query tool exists", () => {
    expect(buildListWindowsCommand(tooling("linux-x11", ["wmctrl"]))?.command).toBe("wmctrl");
    expect(buildListWindowsCommand(tooling("linux-x11", ["xdotool"]))).toBeNull();
    expect(buildListWindowsCommand(tooling("windows", ["powershell"]))?.command).toBe(
      "powershell.exe",
    );
  });

  it("queries display geometry on X11 and Windows", () => {
    expect(buildDisplayGeometryCommand(tooling("linux-x11", ["xrandr"]))?.command).toBe("xrandr");
    expect(buildDisplayGeometryCommand(tooling("windows", ["powershell"]))?.command).toBe(
      "powershell.exe",
    );
  });

  it("focuses windows with wmctrl on X11", () => {
    expect(buildFocusWindowCommand(tooling("linux-x11", ["wmctrl"]), "0x1234")).toEqual({
      command: "wmctrl",
      args: ["-i", "-a", "0x1234"],
    });
    expect(buildFocusWindowCommand(tooling("macos", ["cliclick"]), "1")).toBeNull();
  });
});

describe("encodePowerShell", () => {
  it("round-trips a script as UTF-16LE base64", () => {
    const script = "Write-Output 'caf\u00e9'";
    const encoded = encodePowerShell(script);
    const decoded = Buffer.from(encoded, "base64");
    expect([...decoded]).toEqual([...Buffer.from(script, "utf16le")]);
  });
});
