import type {
  DesktopUseAction,
  DesktopUseBackend,
  DesktopUseDisplay,
  DesktopUseModifier,
  DesktopUseMouseButton,
  DesktopUsePlatform,
} from "@t3tools/contracts";
import {
  captureWindowsScript,
  dragWindowsScript,
  cursorWindowsScript,
  displaysWindowsScript,
  focusWindowsScript,
  keyboardWindowsScript,
  pointerWindowsScript,
  releaseWindowsKeysScript,
  windowsListScript,
} from "./windows.ts";
import {
  macCursor,
  macDrag,
  macDisplays,
  macFocus,
  macKeyboard,
  macPointer,
  macReadiness,
  macReleaseKeys,
  macWindows,
  MAC_KEYS,
} from "./macos.ts";

export const DESKTOP_TOOL_NAMES = [
  "xdotool",
  "ydotool",
  "wtype",
  "grim",
  "gnome-screenshot",
  "spectacle",
  "import",
  "scrot",
  "ffmpeg",
  "wmctrl",
  "xrandr",
  "wlr-randr",
  "gjs",
  "screencapture",
  "osascript",
  "powershell",
] as const;
export type DesktopToolName = (typeof DESKTOP_TOOL_NAMES)[number];
export interface DesktopTooling {
  readonly platform: DesktopUsePlatform;
  readonly backend: DesktopUseBackend;
  readonly tools: ReadonlySet<DesktopToolName>;
  readonly xDisplay?: string;
}
export interface DesktopCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}
export interface CaptureCommand extends DesktopCommand {
  readonly area: "desktop" | "display";
}
export type NativePointerAction =
  | Exclude<Extract<DesktopUseAction, { type: `pointer.${string}` }>, { type: "pointer.drag" }>
  | {
      readonly type: "pointer.down" | "pointer.up";
      readonly button?: DesktopUseMouseButton | undefined;
    };
export const hasTool = (tooling: DesktopTooling, tool: DesktopToolName) => tooling.tools.has(tool);
export function detectDisplayServer(
  env: Readonly<Record<string, string | undefined>>,
): "x11" | "wayland" | null {
  if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return null;
}
export function resolveBackend(input: {
  platform: NodeJS.Platform;
  displayServer: "x11" | "wayland" | null;
}): DesktopUseBackend {
  if (input.platform === "darwin") return "macos";
  if (input.platform === "win32") return "windows";
  if (input.platform === "linux" && input.displayServer !== null)
    return input.displayServer === "wayland" ? "linux-wayland" : "linux-x11";
  return "unavailable";
}
export interface CaptureCommandInput {
  readonly outPath: string;
  readonly display?: DesktopUseDisplay;
}
export function buildCaptureCommands(
  tooling: DesktopTooling,
  input: CaptureCommandInput,
): ReadonlyArray<CaptureCommand> {
  const { outPath, display } = input;
  switch (tooling.backend) {
    case "macos":
      return [
        {
          command: "/usr/sbin/screencapture",
          args: [
            "-x",
            "-t",
            "png",
            ...(display
              ? ["-R", `${display.x},${display.y},${display.width},${display.height}`]
              : ["-m"]),
            outPath,
          ],
          area: "display",
        },
      ];
    case "windows":
      return [
        {
          ...powershellCommand(captureWindowsScript(outPath, display)),
          area: display ? "display" : "desktop",
        },
      ];
    case "linux-x11":
      return [
        ...(hasTool(tooling, "import")
          ? [{ command: "import", args: ["-window", "root", outPath], area: "desktop" as const }]
          : []),
        ...(hasTool(tooling, "scrot")
          ? [{ command: "scrot", args: ["--silent", outPath], area: "desktop" as const }]
          : []),
        ...(hasTool(tooling, "ffmpeg") && tooling.xDisplay
          ? [
              {
                command: "ffmpeg",
                args: [
                  "-y",
                  "-loglevel",
                  "error",
                  "-f",
                  "x11grab",
                  "-i",
                  tooling.xDisplay,
                  "-frames:v",
                  "1",
                  outPath,
                ],
                area: "desktop" as const,
              },
            ]
          : []),
      ];
    case "linux-wayland":
      return [
        ...(hasTool(tooling, "grim")
          ? [
              {
                command: "grim",
                args: [
                  ...(display ? ["-o", display.id, "-s", String(display.scale)] : []),
                  outPath,
                ],
                area: display ? ("display" as const) : ("desktop" as const),
              },
            ]
          : []),
        ...(hasTool(tooling, "gnome-screenshot")
          ? [{ command: "gnome-screenshot", args: ["-f", outPath], area: "desktop" as const }]
          : []),
        ...(hasTool(tooling, "spectacle")
          ? [{ command: "spectacle", args: ["-b", "-n", "-o", outPath], area: "desktop" as const }]
          : []),
      ];
    case "unavailable":
      return [];
  }
}
export const buildCaptureCommand = (tooling: DesktopTooling, input: CaptureCommandInput) =>
  buildCaptureCommands(tooling, input)[0] ?? null;
export const wheelSteps = (delta: number | undefined) =>
  !delta ? 0 : Math.sign(delta) * Math.min(10, Math.max(1, Math.round(Math.abs(delta) / 100)));
const xButton = { left: "1", middle: "2", right: "3" };
const yButton = { left: 0, middle: 2, right: 1 };
const xKey: Readonly<Record<string, string>> = {
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
  ctrl: "Control_L",
  control: "Control_L",
  shift: "Shift_L",
  alt: "Alt_L",
  meta: "Super_L",
  win: "Super_L",
  super: "Super_L",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};
const keysym = (key: string) => xKey[key.toLowerCase()] ?? `U${key.codePointAt(0)!.toString(16)}`;
const xMod = { alt: "alt", control: "ctrl", meta: "super", shift: "shift" };
const wMod = { alt: "alt", control: "ctrl", meta: "logo", shift: "shift" };
export const LINUX_KEYS: Readonly<Record<string, number>> = {
  esc: 1,
  escape: 1,
  backspace: 14,
  tab: 15,
  enter: 28,
  return: 28,
  control: 29,
  ctrl: 29,
  shift: 42,
  alt: 56,
  space: 57,
  capslock: 58,
  home: 102,
  up: 103,
  arrowup: 103,
  pageup: 104,
  left: 105,
  arrowleft: 105,
  right: 106,
  arrowright: 106,
  end: 107,
  down: 108,
  arrowdown: 108,
  pagedown: 109,
  insert: 110,
  delete: 111,
  del: 111,
  meta: 125,
  super: 125,
  win: 125,
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i + 1}`, 59 + i])),
  f11: 87,
  f12: 88,
};
const linuxCharacters: Readonly<Record<string, number>> = Object.fromEntries([
  ...[..."1234567890"].map((key, i) => [key, 2 + i]),
  ...[..."qwertyuiop"].map((key, i) => [key, 16 + i]),
  ...[..."asdfghjkl"].map((key, i) => [key, 30 + i]),
  ...[..."zxcvbnm"].map((key, i) => [key, 44 + i]),
  [" ", 57],
  ["-", 12],
  ["=", 13],
  ["[", 26],
  ["]", 27],
  [";", 39],
  ["'", 40],
  ["`", 41],
  ["\\", 43],
  [",", 51],
  [".", 52],
  ["/", 53],
]);
const yMod = { control: 29, shift: 42, alt: 56, meta: 125 };
export function linuxKey(key: string, modifiers: ReadonlyArray<DesktopUseModifier>) {
  const named = LINUX_KEYS[key.toLowerCase()];
  const shifted = '~!@#$%^&*()_+{}|:"<>?';
  const plain = "`1234567890-=[]\\;',./";
  const character =
    linuxCharacters[shifted.includes(key) ? plain[shifted.indexOf(key)]! : key.toLowerCase()];
  if (named === undefined && character === undefined) return null;
  const mods = [...new Set(modifiers.map((m) => yMod[m]))];
  if (named === undefined && (/[A-Z]/.test(key) || shifted.includes(key)) && !mods.includes(42))
    mods.push(42);
  return { code: named ?? character!, modifiers: mods };
}

export function buildPointerCommands(
  tooling: DesktopTooling,
  action: NativePointerAction,
  dragging?: DesktopUseMouseButton,
): ReadonlyArray<DesktopCommand> {
  const button =
    action.type === "pointer.scroll" || action.type === "pointer.move"
      ? "left"
      : (action.button ?? "left");
  const position =
    "x" in action && action.x !== undefined && action.y !== undefined
      ? { x: Math.round(action.x), y: Math.round(action.y) }
      : undefined;
  if (tooling.backend === "macos")
    return [
      macPointer({
        ...action,
        ...position,
        dragging: dragging !== undefined,
        ...(dragging ? { button: dragging } : {}),
        ...(action.type === "pointer.scroll"
          ? { deltaX: wheelSteps(action.deltaX), deltaY: wheelSteps(action.deltaY) }
          : {}),
      }),
    ];
  if (tooling.backend === "windows")
    return [
      powershellCommand(
        pointerWindowsScript({
          ...action,
          ...position,
          ...(action.type === "pointer.scroll"
            ? { deltaX: wheelSteps(action.deltaX), deltaY: wheelSteps(action.deltaY) }
            : {}),
        }),
      ),
    ];
  const wayland = tooling.backend === "linux-wayland";
  if (tooling.backend !== "linux-x11" && !wayland) return [];
  const command = wayland ? "ydotool" : "xdotool";
  if (!hasTool(tooling, command)) return [];
  const move = position
    ? {
        command,
        args: wayland
          ? ["mousemove", "--absolute", "-x", String(position.x), "-y", String(position.y)]
          : ["mousemove", String(position.x), String(position.y)],
      }
    : undefined;
  const prefix = move ? [move] : [];
  const click = (mask: number) => ({ command, args: ["click", `0x${mask.toString(16)}`] });
  switch (action.type) {
    case "pointer.move":
      return prefix;
    case "pointer.click":
      return [
        ...prefix,
        ...(wayland
          ? [
              {
                command,
                args: [
                  "click",
                  "--repeat",
                  String(action.count ?? 1),
                  `0x${(192 + yButton[button]).toString(16)}`,
                ],
              },
            ]
          : [{ command, args: ["click", "--repeat", String(action.count ?? 1), xButton[button]] }]),
      ];
    case "pointer.down":
      return [
        wayland ? click(64 + yButton[button]) : { command, args: ["mousedown", xButton[button]] },
      ];
    case "pointer.up":
      return [
        wayland ? click(128 + yButton[button]) : { command, args: ["mouseup", xButton[button]] },
      ];
    case "pointer.scroll": {
      const x = wheelSteps(action.deltaX),
        y = wheelSteps(action.deltaY);
      if (wayland)
        return [
          ...prefix,
          { command, args: ["mousemove", "--wheel", "-x", String(x), "-y", String(-y)] },
        ];
      return [
        ...prefix,
        ...(y
          ? [{ command, args: ["click", "--repeat", String(Math.abs(y)), y > 0 ? "5" : "4"] }]
          : []),
        ...(x
          ? [{ command, args: ["click", "--repeat", String(Math.abs(x)), x > 0 ? "7" : "6"] }]
          : []),
      ];
    }
  }
}
export function buildKeyboardCommands(
  tooling: DesktopTooling,
  action: Extract<DesktopUseAction, { type: "keyboard.type" | "keyboard.key" }>,
): ReadonlyArray<DesktopCommand> {
  if (tooling.backend === "macos") return [macKeyboard(action)];
  if (tooling.backend === "windows") {
    if (action.type === "keyboard.key" && [...action.key].length === 1 && action.key.length > 1)
      return [];
    if (action.type === "keyboard.type") {
      const chars = [...action.text];
      return Array.from({ length: Math.max(1, Math.ceil(chars.length / 1024)) }, (_, i) =>
        powershellCommand(
          keyboardWindowsScript({
            ...action,
            text: chars.slice(i * 1024, (i + 1) * 1024).join(""),
          }),
        ),
      );
    }
    return [powershellCommand(keyboardWindowsScript(action))];
  }
  if (tooling.backend === "linux-x11" && hasTool(tooling, "xdotool"))
    return [
      {
        command: "xdotool",
        args:
          action.type === "keyboard.type"
            ? ["type", "--delay", "0", "--", action.text]
            : [
                "key",
                [...(action.modifiers ?? []).map((m) => xMod[m]), keysym(action.key)].join("+"),
              ],
      },
    ];
  if (tooling.backend === "linux-wayland") {
    if (hasTool(tooling, "wtype"))
      return [
        {
          command: "wtype",
          args:
            action.type === "keyboard.type"
              ? ["--", action.text]
              : [
                  ...(action.modifiers ?? []).flatMap((m) => ["-M", wMod[m]]),
                  "-k",
                  keysym(action.key),
                  ...[...(action.modifiers ?? [])].toReversed().flatMap((m) => ["-m", wMod[m]]),
                ],
        },
      ];
    if (hasTool(tooling, "ydotool")) {
      if (action.type === "keyboard.type")
        return /^[\x20-\x7e\n\t]*$/.test(action.text)
          ? [
              {
                command: "ydotool",
                args: [
                  "type",
                  "--escape",
                  "0",
                  "--key-delay",
                  "0",
                  "--key-hold",
                  "0",
                  "--",
                  action.text,
                ],
              },
            ]
          : [];
      const key = linuxKey(action.key, action.modifiers ?? []);
      if (key)
        return [
          {
            command: "ydotool",
            args: [
              "key",
              ...key.modifiers.map((m) => `${m}:1`),
              `${key.code}:1`,
              `${key.code}:0`,
              ...key.modifiers.toReversed().map((m) => `${m}:0`),
            ],
          },
        ];
    }
  }
  return [];
}
export function buildKeyboardReleaseCommands(
  tooling: DesktopTooling,
  action: Extract<DesktopUseAction, { type: "keyboard.type" | "keyboard.key" }>,
): ReadonlyArray<DesktopCommand> {
  const mods = action.type === "keyboard.key" ? (action.modifiers ?? []) : [];
  if (tooling.backend === "linux-wayland") {
    if (hasTool(tooling, "wtype")) return [];
    const key = action.type === "keyboard.key" ? linuxKey(action.key, mods) : null;
    const typed =
      action.type === "keyboard.type"
        ? [...action.text].flatMap((char) => {
            const mapped = linuxKey(char === "\n" ? "enter" : char === "\t" ? "tab" : char, []);
            return mapped ? [mapped.code, ...mapped.modifiers] : [];
          })
        : [];
    const keys = [...new Set(key ? [key.code, ...key.modifiers] : [...typed, 42])];
    return [{ command: "ydotool", args: ["key", ...keys.map((code) => `${code}:0`)] }];
  }
  if (tooling.backend === "linux-x11")
    return [
      {
        command: "xdotool",
        args: [
          "keyup",
          "--delay",
          "0",
          ...(action.type === "keyboard.key"
            ? [keysym(action.key)]
            : [
                ...new Set(
                  [...action.text].map((c) =>
                    c === "\n"
                      ? "Return"
                      : c === "\t"
                        ? "Tab"
                        : `U${c.codePointAt(0)!.toString(16)}`,
                  ),
                ),
                "Shift_L",
              ]),
          ...mods.map((m) => xMod[m]),
        ].filter(Boolean),
      },
    ].filter((c) => c.args.length > 1);
  if (tooling.backend === "macos")
    return action.type === "keyboard.key"
      ? [
          macReleaseKeys([
            ...mods.map((m) => MAC_KEYS[m]!),
            ...(MAC_KEYS[action.key.toLowerCase()] === undefined
              ? []
              : [MAC_KEYS[action.key.toLowerCase()]!]),
          ]),
        ]
      : [macReleaseKeys([0])];
  if (tooling.backend === "windows") return [powershellCommand(releaseWindowsKeysScript(action))];
  return [];
}
export function buildCursorCommand(tooling: DesktopTooling): DesktopCommand | null {
  if (tooling.backend === "macos") return macCursor();
  if (tooling.backend === "windows") return powershellCommand(cursorWindowsScript());
  if (tooling.backend === "linux-x11" && hasTool(tooling, "xdotool"))
    return { command: "xdotool", args: ["getmouselocation", "--shell"] };
  return null;
}
export function buildDisplayGeometryCommand(tooling: DesktopTooling): DesktopCommand | null {
  if (tooling.backend === "macos") return macDisplays();
  if (tooling.backend === "windows") return powershellCommand(displaysWindowsScript());
  if (tooling.backend === "linux-x11" && hasTool(tooling, "xrandr"))
    return { command: "xrandr", args: ["--listactivemonitors"] };
  if (tooling.backend === "linux-wayland" && hasTool(tooling, "wlr-randr"))
    return { command: "wlr-randr", args: ["--json"] };
  return null;
}
export const buildGnomeDisplayCommand = (): DesktopCommand => ({
  command: "gjs",
  args: [
    "-c",
    `
const {Gio,GLib}=imports.gi;
function unpack(value){if(value instanceof GLib.Variant)return unpack(value.deep_unpack());if(Array.isArray(value))return value.map(unpack);if(value&&typeof value==="object"){let out={};for(let key in value)out[key]=unpack(value[key]);return out;}return value;}
const connection=Gio.bus_get_sync(Gio.BusType.SESSION,null);
const state=unpack(connection.call_sync("org.gnome.Mutter.DisplayConfig","/org/gnome/Mutter/DisplayConfig","org.gnome.Mutter.DisplayConfig","GetCurrentState",null,null,Gio.DBusCallFlags.NONE,3000,null));
const out=[];
for(const logical of state[2]){
  const [x,y,scale,transform,primary,specs]=logical;
  for(const spec of specs){
    const monitor=state[1].find(m=>m[0][0]===spec[0]);
    const mode=monitor&&monitor[1].find(m=>m[6]["is-current"]);
    if(mode){const rotated=transform%2===1;out.push({id:spec[0],x,y,scale,primary,width:Math.round((rotated?mode[2]:mode[1])/scale),height:Math.round((rotated?mode[1]:mode[2])/scale)});}
  }
}
print(JSON.stringify(out));
`,
  ],
});
export const buildMacReadinessCommand = macReadiness;
export function buildListWindowsCommand(tooling: DesktopTooling): DesktopCommand | null {
  if (tooling.backend === "macos") return macWindows();
  if (tooling.backend === "windows") return powershellCommand(windowsListScript());
  if (tooling.backend === "linux-x11" && hasTool(tooling, "wmctrl"))
    return { command: "wmctrl", args: ["-lpGx"] };
  return null;
}
export function buildFocusWindowCommand(
  tooling: DesktopTooling,
  id: string,
): DesktopCommand | null {
  if (tooling.backend === "macos") return macFocus(id);
  if (tooling.backend === "windows") return powershellCommand(focusWindowsScript(id));
  if (tooling.backend === "linux-x11" && hasTool(tooling, "wmctrl"))
    return { command: "wmctrl", args: ["-i", "-a", id] };
  return null;
}
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}
export function powershellCommand(script: string): DesktopCommand {
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
  };
}

export const buildNativeDragCommand = (
  tools: DesktopTooling,
  action: Extract<DesktopUseAction, { type: "pointer.drag" }>,
): DesktopCommand | undefined =>
  tools.backend === "windows"
    ? powershellCommand(dragWindowsScript(action))
    : tools.backend === "macos"
      ? macDrag(action)
      : undefined;
