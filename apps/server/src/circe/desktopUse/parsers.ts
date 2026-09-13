import type { DesktopUseDisplay, DesktopUseWindow } from "@t3tools/contracts";
import {
  DesktopUseDisplay as DisplaySchema,
  DesktopUseWindow as WindowSchema,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

/**
 * Output parsers for the platform tools. Kept pure so every OS dialect can be
 * exercised from a fixture on any host.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const hasPngSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 24 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

/**
 * Reads width and height from a PNG IHDR chunk. Returns null on anything that
 * is not a PNG with a readable header.
 */
export function readPngSize(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | null {
  if (!hasPngSignature(bytes)) return null;
  // IHDR must be the first chunk: 4-byte length, "IHDR", then width and height.
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (type !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

const XRANDR_LINE = /^\d+:\s+([+*]*)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+([+-]\d+)([+-]\d+)/;

/** `xrandr --listactivemonitors` reports logical monitor rectangles in root-window coordinates. */
export function parseXrandrDisplays(output: string): ReadonlyArray<DesktopUseDisplay> {
  const displays: Array<DesktopUseDisplay> = [];
  for (const line of output.split("\n")) {
    const match = XRANDR_LINE.exec(line.trim());
    if (!match) continue;
    displays.push({
      id: match[2]!,
      name: match[2]!,
      x: Number(match[5]),
      y: Number(match[6]),
      width: Number(match[3]),
      height: Number(match[4]),
      scale: 1,
      primary: match[1]!.includes("*"),
    });
  }
  if (displays.length > 0) {
    if (!displays.some((display) => display.primary)) {
      displays[0] = { ...displays[0]!, primary: true };
    }
    return displays;
  }
  return [];
}

/** `xdotool getmouselocation --shell` prints `X=…` and `Y=…`. */
export function parseXdotoolCursor(output: string): { x: number; y: number } | null {
  const x = /^X=(-?\d+)$/m.exec(output)?.[1];
  const y = /^Y=(-?\d+)$/m.exec(output)?.[1];
  if (x === undefined || y === undefined) return null;
  return { x: Number(x), y: Number(y) };
}

/** The native macOS and PowerShell probes both print `x,y`. */
export function parseCommaCursor(output: string): { x: number; y: number } | null {
  const match = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(output);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

/**
 * `wmctrl -lpGx` columns: id, desktop, pid, x, y, width, height, wm_class,
 * host, then the title (which may contain spaces). Active window is not known
 * from wmctrl alone, so it is reported false.
 */
export function parseWmctrlWindows(output: string): ReadonlyArray<DesktopUseWindow> {
  const windows: Array<DesktopUseWindow> = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 9) continue;
    const [id, , , x, y, width, height, wmClass] = fields;
    const title = fields.slice(9).join(" ");
    windows.push({
      id: id!,
      title: title.length > 0 ? title : wmClass!,
      appName: wmClass,
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
      active: false,
    });
  }
  return windows;
}

const decodeWindows = Schema.decodeUnknownOption(Schema.Array(WindowSchema));
const decodeDisplays = Schema.decodeUnknownOption(Schema.Array(DisplaySchema));

export function parseJsonWindows(output: string): ReadonlyArray<DesktopUseWindow> {
  try {
    const parsed: unknown = JSON.parse(output);
    return Option.getOrElse(decodeWindows(Array.isArray(parsed) ? parsed : [parsed]), () => []);
  } catch {
    return [];
  }
}

/** Native probes emit the shared shape; reject malformed catalogs rather than inventing targets. */
export function parseNativeDisplays(output: string): ReadonlyArray<DesktopUseDisplay> {
  try {
    const decoded = decodeDisplays(JSON.parse(output));
    return Option.getOrElse(decoded, () => []);
  } catch {
    return [];
  }
}

const WlrOutput = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Literal(true),
  scale: Schema.Finite,
  position: Schema.Struct({ x: Schema.Int, y: Schema.Int }),
  transform: Schema.String,
  modes: Schema.Array(
    Schema.Struct({
      width: Schema.Int,
      height: Schema.Int,
      current: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodeWlr = Schema.decodeUnknownSync(
  Schema.Array(Schema.Union([WlrOutput, Schema.Struct({ enabled: Schema.Literal(false) })])),
);
export function parseWlrDisplays(output: string): ReadonlyArray<DesktopUseDisplay> {
  try {
    const decoded = decodeWlr(JSON.parse(output));
    const displays = decoded.flatMap((output) => {
      if (!output.enabled) return [];
      const mode = output.modes.find((mode) => mode.current);
      if (!output.enabled || !mode || output.scale <= 0) return [];
      const rotated = output.transform.includes("90") || output.transform.includes("270");
      return [
        {
          id: output.name,
          x: output.position.x,
          y: output.position.y,
          width: Math.round((rotated ? mode.height : mode.width) / output.scale),
          height: Math.round((rotated ? mode.width : mode.height) / output.scale),
          scale: output.scale,
          primary: false,
        },
      ];
    });
    return displays.map((display, index) => ({ ...display, primary: index === 0 }));
  } catch {
    return [];
  }
}
