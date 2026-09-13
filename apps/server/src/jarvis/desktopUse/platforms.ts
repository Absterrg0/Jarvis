import type {
  DesktopUseAction,
  DesktopUseBackend,
  DesktopUseModifier,
  DesktopUseMouseButton,
  DesktopUsePlatform,
} from "@t3tools/contracts";

/**
 * Pure platform mechanics for desktop use. Nothing here spawns a process or
 * touches the filesystem, so the exact command lines for every supported OS are
 * unit-testable on any host.
 */

export const DESKTOP_TOOL_NAMES = [
  "xdotool",
  "ydotool",
  "wtype",
  "grim",
  "gnome-screenshot",
  "spectacle",
  "import",
  "magick",
  "scrot",
  "ffmpeg",
  "screencapture",
  "cliclick",
  "osascript",
  "wmctrl",
  "xrandr",
  "powershell",
] as const;
export type DesktopToolName = (typeof DESKTOP_TOOL_NAMES)[number];

export interface DesktopTooling {
  readonly platform: DesktopUsePlatform;
  readonly backend: DesktopUseBackend;
  readonly tools: ReadonlySet<DesktopToolName>;
}

export interface DesktopCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export const hasTool = (tooling: DesktopTooling, tool: DesktopToolName): boolean =>
  tooling.tools.has(tool);

export function resolveBackend(input: {
  readonly platform: NodeJS.Platform;
  readonly displayServer: "x11" | "wayland" | null;
}): DesktopUseBackend {
  if (input.platform === "darwin") return "macos";
  if (input.platform === "win32") return "windows";
  if (input.platform === "linux") {
    return input.displayServer === "wayland" ? "linux-wayland" : "linux-x11";
  }
  return "unavailable";
}

/** Detect Wayland from the environment without touching the process or filesystem. */
export function detectDisplayServer(
  env: Readonly<Record<string, string | undefined>>,
): "x11" | "wayland" | null {
  if (env.XDG_SESSION_TYPE === "wayland" || (env.WAYLAND_DISPLAY ?? "").length > 0) {
    return "wayland";
  }
  if (env.XDG_SESSION_TYPE === "x11" || (env.DISPLAY ?? "").length > 0) return "x11";
  return null;
}

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

export interface CaptureCommandInput {
  readonly outPath: string;
  readonly display?: string;
}

/**
 * Capture candidates in preference order. The driver tries each until one
 * produces a readable PNG, so a present-but-broken helper does not take the
 * capability down with it.
 */
export function buildCaptureCommands(
  tooling: DesktopTooling,
  input: CaptureCommandInput,
): ReadonlyArray<DesktopCommand> {
  switch (tooling.backend) {
    case "macos":
      // `-x` silences the shutter, `-t png` forces PNG, `-D n` picks a display.
      return [
        {
          command: "/usr/sbin/screencapture",
          args: [
            "-x",
            "-t",
            "png",
            ...(isDisplayIndex(input.display) ? ["-D", input.display] : []),
            input.outPath,
          ],
        },
      ];
    case "windows":
      return [powershellCommand(captureWindowsScript(input.outPath))];
    case "linux-x11": {
      const candidates: Array<DesktopCommand> = [];
      if (hasTool(tooling, "import")) {
        candidates.push({ command: "import", args: ["-window", "root", input.outPath] });
      }
      if (hasTool(tooling, "scrot")) {
        candidates.push({ command: "scrot", args: ["--silent", input.outPath] });
      }
      if (hasTool(tooling, "ffmpeg")) {
        candidates.push({
          command: "ffmpeg",
          args: [
            "-y",
            "-loglevel",
            "error",
            "-f",
            "x11grab",
            "-i",
            processDisplay(input.display),
            "-frames:v",
            "1",
            input.outPath,
          ],
        });
      }
      return candidates;
    }
    case "linux-wayland": {
      const candidates: Array<DesktopCommand> = [];
      if (hasTool(tooling, "grim")) {
        candidates.push({
          command: "grim",
          args: [...(isDisplayIndex(input.display) ? ["-o", input.display] : []), input.outPath],
        });
      }
      if (hasTool(tooling, "gnome-screenshot")) {
        candidates.push({ command: "gnome-screenshot", args: ["-f", input.outPath] });
      }
      if (hasTool(tooling, "spectacle")) {
        candidates.push({
          command: "spectacle",
          args: [
            "-b",
            "-n",
            "-o",
            input.outPath,
            ...(isDisplayIndex(input.display) ? ["-d", input.display] : []),
          ],
        });
      }
      // XWayland fallback: works for X11 clients when no native portal helper exists.
      if (hasTool(tooling, "import")) {
        candidates.push({ command: "import", args: ["-window", "root", input.outPath] });
      }
      if (hasTool(tooling, "ffmpeg")) {
        candidates.push({
          command: "ffmpeg",
          args: [
            "-y",
            "-loglevel",
            "error",
            "-f",
            "x11grab",
            "-i",
            processDisplay(input.display),
            "-frames:v",
            "1",
            input.outPath,
          ],
        });
      }
      return candidates;
    }
    case "unavailable":
      return [];
  }
}

export function buildCaptureCommand(
  tooling: DesktopTooling,
  input: CaptureCommandInput,
): DesktopCommand | null {
  return buildCaptureCommands(tooling, input)[0] ?? null;
}

const processDisplay = (display: string | undefined): string =>
  display && /^:\d+(\.\d+)?$/.test(display) ? display : ":0.0";

const isDisplayIndex = (value: string | undefined): value is string =>
  value !== undefined && /^\d+$/.test(value);

/* ------------------------------------------------------------------ *
 * Pointer
 * ------------------------------------------------------------------ */

const X11_BUTTON: Readonly<Record<DesktopUseMouseButton, string>> = {
  left: "1",
  middle: "2",
  right: "3",
};

const YDOTOOL_BUTTON: Readonly<Record<DesktopUseMouseButton, string>> = {
  left: "0xC0",
  middle: "0xC2",
  right: "0xC1",
};

export function buildPointerCommands(
  tooling: DesktopTooling,
  action: Extract<
    DesktopUseAction,
    {
      type:
        | "pointer.move"
        | "pointer.click"
        | "pointer.down"
        | "pointer.up"
        | "pointer.drag"
        | "pointer.scroll";
    }
  >,
): ReadonlyArray<DesktopCommand> {
  if (tooling.backend === "linux-x11") return x11PointerCommands(action);
  if (tooling.backend === "linux-wayland") return waylandPointerCommands(action);
  if (tooling.backend === "macos") return macPointerCommands(action);
  if (tooling.backend === "windows") return windowsPointerCommands(action);
  return [];
}

function x11PointerCommands(
  action: Extract<DesktopUseAction, { type: `pointer.${string}` }>,
): ReadonlyArray<DesktopCommand> {
  const xdotool = (args: ReadonlyArray<string>): DesktopCommand => ({
    command: "xdotool",
    args,
  });
  switch (action.type) {
    case "pointer.move":
      return [xdotool(["mousemove", "--sync", String(action.x), String(action.y)])];
    case "pointer.click": {
      const args = [
        ...(action.x !== undefined && action.y !== undefined
          ? ["mousemove", "--sync", String(action.x), String(action.y)]
          : []),
        "click",
        "--repeat",
        String(action.count ?? 1),
        X11_BUTTON[action.button ?? "left"],
      ];
      return [xdotool(args)];
    }
    case "pointer.down":
      return [xdotool(["mousedown", X11_BUTTON[action.button ?? "left"]])];
    case "pointer.up":
      return [xdotool(["mouseup", X11_BUTTON[action.button ?? "left"]])];
    case "pointer.drag":
      return [
        xdotool(["mousemove", "--sync", String(action.from.x), String(action.from.y)]),
        xdotool(["mousedown", X11_BUTTON[action.button ?? "left"]]),
        xdotool([
          "mousemove",
          "--sync",
          "--delay",
          String(Math.max(1, Math.round((action.durationMs ?? 250) / 10))),
          String(action.to.x),
          String(action.to.y),
        ]),
        xdotool(["mouseup", X11_BUTTON[action.button ?? "left"]]),
      ];
    case "pointer.scroll": {
      const commands: Array<DesktopCommand> = [];
      if (action.x !== undefined && action.y !== undefined) {
        commands.push(xdotool(["mousemove", "--sync", String(action.x), String(action.y)]));
      }
      const vertical = verticalClicks(action.deltaY);
      if (vertical !== 0) {
        commands.push(
          xdotool(["click", "--repeat", String(Math.abs(vertical)), vertical > 0 ? "5" : "4"]),
        );
      }
      const horizontal = verticalClicks(action.deltaX);
      if (horizontal !== 0) {
        commands.push(
          xdotool(["click", "--repeat", String(Math.abs(horizontal)), horizontal > 0 ? "7" : "6"]),
        );
      }
      return commands;
    }
  }
}

function waylandPointerCommands(
  action: Extract<DesktopUseAction, { type: `pointer.${string}` }>,
): ReadonlyArray<DesktopCommand> {
  // ydotool drives /dev/uinput; there is no portable pointer query, but the
  // absolute move and click vocabulary is enough for agents that read frames.
  const ydotool = (args: ReadonlyArray<string>): DesktopCommand => ({ command: "ydotool", args });
  switch (action.type) {
    case "pointer.move":
      return [ydotool(["mousemove", "--absolute", String(action.x), String(action.y)])];
    case "pointer.click": {
      const commands: Array<DesktopCommand> = [];
      if (action.x !== undefined && action.y !== undefined) {
        commands.push(ydotool(["mousemove", "--absolute", String(action.x), String(action.y)]));
      }
      for (let i = 0; i < (action.count ?? 1); i += 1) {
        commands.push(ydotool(["click", YDOTOOL_BUTTON[action.button ?? "left"]]));
      }
      return commands;
    }
    case "pointer.down":
      return [ydotool(["mousedown", YDOTOOL_BUTTON[action.button ?? "left"]])];
    case "pointer.up":
      return [ydotool(["mouseup", YDOTOOL_BUTTON[action.button ?? "left"]])];
    case "pointer.drag":
      return [
        ydotool(["mousemove", "--absolute", String(action.from.x), String(action.from.y)]),
        ydotool(["mousedown", YDOTOOL_BUTTON[action.button ?? "left"]]),
        ydotool(["mousemove", "--absolute", String(action.to.x), String(action.to.y)]),
        ydotool(["mouseup", YDOTOOL_BUTTON[action.button ?? "left"]]),
      ];
    case "pointer.scroll": {
      const commands: Array<DesktopCommand> = [];
      if (action.x !== undefined && action.y !== undefined) {
        commands.push(ydotool(["mousemove", "--absolute", String(action.x), String(action.y)]));
      }
      const vertical = verticalClicks(action.deltaY);
      for (let i = 0; i < Math.abs(vertical); i += 1) {
        // ydotool wheel buttons: 0xC4 up, 0xC5 down.
        commands.push(ydotool(["click", vertical > 0 ? "0xC5" : "0xC4"]));
      }
      const horizontal = verticalClicks(action.deltaX);
      for (let i = 0; i < Math.abs(horizontal); i += 1) {
        commands.push(ydotool(["click", horizontal > 0 ? "0xC7" : "0xC6"]));
      }
      return commands;
    }
  }
}

function macPointerCommands(
  action: Extract<DesktopUseAction, { type: `pointer.${string}` }>,
): ReadonlyArray<DesktopCommand> {
  const cliclick = (args: ReadonlyArray<string>): DesktopCommand => ({ command: "cliclick", args });
  switch (action.type) {
    case "pointer.move":
      return [cliclick([`m:${round(action.x)},${round(action.y)}`])];
    case "pointer.click": {
      const button = action.button ?? "left";
      const target =
        action.x !== undefined && action.y !== undefined
          ? `${round(action.x)},${round(action.y)}`
          : "";
      const count = action.count ?? 1;
      if (button === "left") {
        if (count === 2) return [cliclick([`dc:${target}`])];
        if (count === 3) return [cliclick([`tc:${target}`])];
        return [cliclick([`c:${target}`])];
      }
      if (button === "right") return [cliclick([`rc:${target}`])];
      return [cliclick([`mc:${target}`])];
    }
    case "pointer.down": {
      const button = action.button ?? "left";
      return [cliclick([button === "right" ? "rd" : button === "middle" ? "md" : "dd"])];
    }
    case "pointer.up": {
      const button = action.button ?? "left";
      return [cliclick([button === "right" ? "ru" : button === "middle" ? "mu" : "du"])];
    }
    case "pointer.drag":
      return [
        cliclick([
          `dd:${round(action.from.x)},${round(action.from.y)}`,
          `dm:${round((action.from.x + action.to.x) / 2)},${round((action.from.y + action.to.y) / 2)}`,
          `du:${round(action.to.x)},${round(action.to.y)}`,
        ]),
      ];
    case "pointer.scroll":
      // cliclick cannot scroll; the policy layer reports scroll unavailable on macOS.
      return [];
  }
}

function windowsPointerCommands(
  action: Extract<DesktopUseAction, { type: `pointer.${string}` }>,
): ReadonlyArray<DesktopCommand> {
  const payload: Record<string, unknown> = { type: action.type };
  if (action.type === "pointer.move") Object.assign(payload, { x: action.x, y: action.y });
  if (action.type === "pointer.click") {
    Object.assign(payload, {
      x: action.x,
      y: action.y,
      button: action.button ?? "left",
      count: action.count ?? 1,
    });
  }
  if (action.type === "pointer.down" || action.type === "pointer.up") {
    payload.button = action.button ?? "left";
  }
  if (action.type === "pointer.drag") {
    Object.assign(payload, { from: action.from, to: action.to, button: action.button ?? "left" });
  }
  if (action.type === "pointer.scroll") {
    Object.assign(payload, {
      x: action.x,
      y: action.y,
      deltaX: action.deltaX ?? 0,
      deltaY: action.deltaY ?? 0,
    });
  }
  return [powershellCommand(pointerWindowsScript(JSON.stringify(payload)))];
}

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */

const XDOTOOL_KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  capslock: "Caps_Lock",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
};

const XDOTOOL_MODIFIER: Readonly<Record<DesktopUseModifier, string>> = {
  alt: "alt",
  control: "ctrl",
  meta: "super",
  shift: "shift",
};

const WTYPE_MODIFIER: Readonly<Record<DesktopUseModifier, string>> = {
  alt: "-M alt -m alt",
  control: "-M ctrl -m ctrl",
  meta: "-M logo -m logo",
  shift: "-M shift -m shift",
};

const APPLESCRIPT_MODIFIER: Readonly<Record<DesktopUseModifier, string>> = {
  alt: "option down",
  control: "control down",
  meta: "command down",
  shift: "shift down",
};

export function buildKeyboardCommands(
  tooling: DesktopTooling,
  action: Extract<DesktopUseAction, { type: "keyboard.type" | "keyboard.key" }>,
): ReadonlyArray<DesktopCommand> {
  if (action.type === "keyboard.type") {
    return typeTextCommands(tooling, action.text);
  }
  const modifiers = action.modifiers ?? [];
  switch (tooling.backend) {
    case "linux-x11":
      return [x11KeyCommand(action.key, modifiers)];
    case "linux-wayland":
      if (hasTool(tooling, "wtype")) {
        return [
          {
            command: "wtype",
            args: [
              ...modifiers.flatMap((modifier) => WTYPE_MODIFIER[modifier].split(" ")),
              "-k",
              normalizeWtypeKey(action.key),
            ],
          },
        ];
      }
      return [];
    case "macos":
      if (hasTool(tooling, "cliclick")) {
        const chord = [modifiers.map(cliclickModifier).join(""), cliclickKey(action.key)]
          .filter((part) => part.length > 0)
          .join("+");
        return [{ command: "cliclick", args: [`kp:${chord}`] }];
      }
      return [applescriptKeyCommand(action.key, modifiers)];
    case "windows":
      return [powershellCommand(keyWindowsScript(JSON.stringify({ key: action.key, modifiers })))];
    case "unavailable":
      return [];
  }
}

function x11KeyCommand(key: string, modifiers: ReadonlyArray<DesktopUseModifier>): DesktopCommand {
  const parts = [
    ...modifiers.map((modifier) => XDOTOOL_MODIFIER[modifier]),
    XDOTOOL_KEY_ALIASES[key.toLowerCase()] ?? key,
  ];
  return { command: "xdotool", args: ["key", "--clearmodifiers", parts.join("+")] };
}

function typeTextCommands(tooling: DesktopTooling, text: string): ReadonlyArray<DesktopCommand> {
  switch (tooling.backend) {
    case "linux-x11":
      return [
        { command: "xdotool", args: ["type", "--clearmodifiers", "--delay", "2", "--", text] },
      ];
    case "linux-wayland":
      if (hasTool(tooling, "wtype")) return [{ command: "wtype", args: ["--", text] }];
      if (hasTool(tooling, "ydotool")) return [{ command: "ydotool", args: ["type", "--", text] }];
      return [];
    case "macos":
      if (hasTool(tooling, "cliclick")) return [{ command: "cliclick", args: [`t:${text}`] }];
      return [applescriptTypeCommand(text)];
    case "windows":
      return [powershellCommand(typeWindowsScript(JSON.stringify({ text })))];
    case "unavailable":
      return [];
  }
}

function applescriptTypeCommand(text: string): DesktopCommand {
  return {
    command: "/usr/bin/osascript",
    args: ["-e", `tell application "System Events" to keystroke ${appleScriptString(text)}`],
  };
}

function applescriptKeyCommand(
  key: string,
  modifiers: ReadonlyArray<DesktopUseModifier>,
): DesktopCommand {
  const using = modifiers.map((modifier) => APPLESCRIPT_MODIFIER[modifier]).join(", ");
  const usingClause = using.length > 0 ? ` using {${using}}` : "";
  const special = applescriptSpecialKeyCode(key);
  if (special !== null) {
    return {
      command: "/usr/bin/osascript",
      args: ["-e", `tell application "System Events" to key code ${special}${usingClause}`],
    };
  }
  return {
    command: "/usr/bin/osascript",
    args: [
      "-e",
      `tell application "System Events" to keystroke ${appleScriptString(key)}${usingClause}`,
    ],
  };
}

const APPLESCRIPT_KEY_CODES: Readonly<Record<string, number>> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  left: 123,
  arrowleft: 123,
  right: 124,
  arrowright: 124,
  down: 125,
  arrowdown: 125,
  up: 126,
  arrowup: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

const applescriptSpecialKeyCode = (key: string): number | null =>
  APPLESCRIPT_KEY_CODES[key.toLowerCase()] ?? null;

const appleScriptString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const cliclickKey = (key: string): string => XDOTOOL_KEY_ALIASES[key.toLowerCase()] ?? key;

const cliclickModifier = (modifier: DesktopUseModifier): string =>
  modifier === "meta" ? "cmd" : modifier === "control" ? "ctrl" : modifier;

const normalizeWtypeKey = (key: string): string => XDOTOOL_KEY_ALIASES[key.toLowerCase()] ?? key;

/* ------------------------------------------------------------------ *
 * Cursor, displays, windows
 * ------------------------------------------------------------------ */

export function buildCursorCommand(tooling: DesktopTooling): DesktopCommand | null {
  switch (tooling.backend) {
    case "linux-x11":
      return { command: "xdotool", args: ["getmouselocation", "--shell"] };
    case "macos":
      return hasTool(tooling, "cliclick") ? { command: "cliclick", args: ["p"] } : null;
    case "windows":
      return powershellCommand(cursorWindowsScript());
    case "linux-wayland":
      return null;
    case "unavailable":
      return null;
  }
}

export function buildDisplayGeometryCommand(tooling: DesktopTooling): DesktopCommand | null {
  switch (tooling.backend) {
    case "linux-x11":
      return hasTool(tooling, "xrandr") ? { command: "xrandr", args: ["--query"] } : null;
    case "macos":
      return {
        command: "/usr/bin/osascript",
        args: ["-e", 'tell application "Finder" to get bounds of window of desktop'],
      };
    case "windows":
      return powershellCommand(displaysWindowsScript());
    case "linux-wayland":
      return hasTool(tooling, "xrandr") ? { command: "xrandr", args: ["--query"] } : null;
    case "unavailable":
      return null;
  }
}

export function buildListWindowsCommand(tooling: DesktopTooling): DesktopCommand | null {
  switch (tooling.backend) {
    case "linux-x11":
      if (hasTool(tooling, "wmctrl")) return { command: "wmctrl", args: ["-lpGx"] };
      return null;
    case "macos":
      return {
        command: "/usr/bin/osascript",
        args: [
          "-l",
          "JavaScript",
          "-e",
          'const se = Application("System Events"); const out = se.processes.whose({visible: true})().flatMap(p => p.windows().map(w => ({ app: p.name(), title: w.name(), x: w.position()[0], y: w.position()[1], width: w.size()[0], height: w.size()[1] }))); JSON.stringify(out)',
        ],
      };
    case "windows":
      return powershellCommand(windowsListScript());
    case "linux-wayland":
      return null;
    case "unavailable":
      return null;
  }
}

export function buildFocusWindowCommand(
  tooling: DesktopTooling,
  windowId: string,
): DesktopCommand | null {
  switch (tooling.backend) {
    case "linux-x11":
      return hasTool(tooling, "wmctrl")
        ? { command: "wmctrl", args: ["-i", "-a", windowId] }
        : null;
    case "windows":
      return powershellCommand(focusWindowsScript(windowId));
    case "macos":
    case "linux-wayland":
    case "unavailable":
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * PowerShell transport
 * ------------------------------------------------------------------ */

const POWERSHELL_HEADER = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
].join("; ");

export function powershellCommand(script: string): DesktopCommand {
  const full = `${POWERSHELL_HEADER}; ${script}`;
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(full),
    ],
  };
}

/** PowerShell reads `-EncodedCommand` as base64 of a UTF-16LE string. */
export function encodePowerShell(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let index = 0; index < script.length; index += 1) {
    const code = script.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = (code >> 8) & 0xff;
  }
  return Buffer.from(bytes).toString("base64");
}

const SEND_INPUT_DEFINITION = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class T3Input {",
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, IntPtr e);',
  "}",
].join("\n");

const MOUSE_BUTTON_FLAGS = [
  "$btn = $payload.button",
  "$down = @{ left=0x0002; middle=0x0020; right=0x0008 }[$btn]",
  "$up = @{ left=0x0004; middle=0x0040; right=0x0010 }[$btn]",
].join("; ");

function captureWindowsScript(outPath: string): string {
  return [
    `$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen`,
    `$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height`,
    `$gfx = [System.Drawing.Graphics]::FromImage($bmp)`,
    `$gfx.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)`,
    `$bmp.Save(${psString(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    `$gfx.Dispose(); $bmp.Dispose()`,
  ].join("; ");
}

function cursorWindowsScript(): string {
  return (
    "Add-Type -TypeDefinition @'\n" +
    SEND_INPUT_DEFINITION +
    '\n\'@; $p=[System.Windows.Forms.Cursor]::Position; Write-Output "$($p.X),$($p.Y)"'
  );
}

function displaysWindowsScript(): string {
  return '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ id="$($_.DeviceName)"; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height } } | ConvertTo-Json -Compress';
}

function windowsListScript(): string {
  return "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { [pscustomobject]@{ id=[string]$_.Id; title=$_.MainWindowTitle; appName=$_.ProcessName; x=0; y=0; width=0; height=0; active=$false } } | ConvertTo-Json -Compress";
}

function focusWindowsScript(windowId: string): string {
  return [
    `$id = ${psString(windowId)}`,
    `$p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue`,
    `if ($null -ne $p -and $p.MainWindowHandle -ne 0) {`,
    `  Add-Type -TypeDefinition @'`,
    SEND_INPUT_DEFINITION.replace(
      "public static class T3Input {",
      'public static class T3Focus { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    ),
    "'@",
    `  [T3Focus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [T3Focus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }`,
  ].join(" ");
}

function pointerWindowsScript(payloadJson: string): string {
  return [
    `$payload = ConvertFrom-Json ${psString(payloadJson)}`,
    "Add-Type -TypeDefinition @'",
    SEND_INPUT_DEFINITION,
    "'@",
    `if ($payload.type -ne 'pointer.scroll' -and $null -ne $payload.x -and $null -ne $payload.y) { [T3Input]::SetCursorPos([int]$payload.x, [int]$payload.y) | Out-Null; Start-Sleep -Milliseconds 30 }`,
    `switch ($payload.type) {`,
    `  'pointer.move' { }`,
    `  'pointer.click' { ${MOUSE_BUTTON_FLAGS}; for ($i=0; $i -lt [int]$payload.count; $i++) { [T3Input]::mouse_event($down,0,0,0,[IntPtr]::Zero); [T3Input]::mouse_event($up,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 20 } }`,
    `  'pointer.down' { ${MOUSE_BUTTON_FLAGS}; [T3Input]::mouse_event($down,0,0,0,[IntPtr]::Zero) }`,
    `  'pointer.up' { ${MOUSE_BUTTON_FLAGS}; [T3Input]::mouse_event($up,0,0,0,[IntPtr]::Zero) }`,
    `  'pointer.drag' { [T3Input]::SetCursorPos([int]$payload.from.x,[int]$payload.from.y) | Out-Null; ${MOUSE_BUTTON_FLAGS}; [T3Input]::mouse_event($down,0,0,0,[IntPtr]::Zero); $steps=12; for ($i=1; $i -le $steps; $i++) { $x=[int]($payload.from.x + ($payload.to.x-$payload.from.x)*$i/$steps); $y=[int]($payload.from.y + ($payload.to.y-$payload.from.y)*$i/$steps); [T3Input]::SetCursorPos($x,$y) | Out-Null; Start-Sleep -Milliseconds 15 }; [T3Input]::mouse_event($up,0,0,0,[IntPtr]::Zero) }`,
    `  'pointer.scroll' { $v=[int]$payload.deltaY; while ($v -ne 0) { $step=[Math]::Sign($v)*120; [T3Input]::mouse_event(0x0800,0,0,[uint32]$step,[IntPtr]::Zero); $v -= [Math]::Sign($v) }; $h=[int]$payload.deltaX; while ($h -ne 0) { $step=[Math]::Sign($h)*120; [T3Input]::mouse_event(0x01000,0,0,[uint32]$step,[IntPtr]::Zero); $h -= [Math]::Sign($h) } }`,
    `}`,
  ].join(" ");
}

const WINDOWS_VK: Readonly<Record<string, number>> = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  up: 0x26,
  arrowup: 0x26,
  down: 0x28,
  arrowdown: 0x28,
  left: 0x25,
  arrowleft: 0x25,
  right: 0x27,
  arrowright: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  shift: 0x10,
  control: 0x11,
  ctrl: 0x11,
  alt: 0x12,
  meta: 0x5b,
  win: 0x5b,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
};

function keyWindowsScript(payloadJson: string): string {
  const virtualKeys = JSON.stringify(WINDOWS_VK);
  return [
    `$payload = ConvertFrom-Json ${psString(payloadJson)}`,
    `$vk = ConvertFrom-Json ${psString(virtualKeys)}`,
    `$key = $payload.key.ToLower()`,
    `$code = if ($vk.PSObject.Properties.Name -contains $key) { [byte]$vk.$key } else { [byte][char]$payload.key[0] }`,
    `$mods = @(); foreach ($m in $payload.modifiers) { if ($m -eq 'control') { $mods += 0x11 } elseif ($m -eq 'shift') { $mods += 0x10 } elseif ($m -eq 'alt') { $mods += 0x12 } elseif ($m -eq 'meta') { $mods += 0x5b } }`,
    `Add-Type -TypeDefinition @'`,
    SEND_INPUT_DEFINITION,
    "'@",
    `foreach ($m in $mods) { [T3Input]::keybd_event([byte]$m,0,0,[IntPtr]::Zero) }`,
    `[T3Input]::keybd_event($code,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 10; [T3Input]::keybd_event($code,0,2,[IntPtr]::Zero)`,
    `foreach ($m in $mods) { [T3Input]::keybd_event([byte]$m,0,2,[IntPtr]::Zero) }`,
  ].join(" ");
}

function typeWindowsScript(payloadJson: string): string {
  return [
    `$payload = ConvertFrom-Json ${psString(payloadJson)}`,
    "Add-Type -TypeDefinition @'",
    SEND_INPUT_DEFINITION,
    "'@",
    `foreach ($ch in $payload.text.ToCharArray()) { $code=[System.Windows.Forms.Keys]::Parse([string][int]$ch, $true); [T3Input]::keybd_event([byte]$code,0,0,[IntPtr]::Zero); [T3Input]::keybd_event([byte]$code,0,2,[IntPtr]::Zero) }`,
  ].join(" ");
}

const psString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const round = (value: number): number => Math.round(value);

const verticalClicks = (delta: number | undefined): number => {
  if (delta === undefined || delta === 0) return 0;
  return Math.sign(delta) * Math.max(1, Math.min(10, Math.round(Math.abs(delta) / 100)));
};
