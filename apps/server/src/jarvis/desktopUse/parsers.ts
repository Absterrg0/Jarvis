import type { DesktopUseDisplay, DesktopUseWindow } from "@t3tools/contracts";

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

const XRANDR_LINE = /^(\S+) connected\s+(primary\s+)?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/;

/** `xrandr --query` output into displays. Scale is not reported; assume 1. */
export function parseXrandrDisplays(
  output: string,
  fallbackSize?: { readonly width: number; readonly height: number },
): ReadonlyArray<DesktopUseDisplay> {
  const displays: Array<DesktopUseDisplay> = [];
  for (const line of output.split("\n")) {
    const match = XRANDR_LINE.exec(line.trim());
    if (!match) continue;
    displays.push({
      id: match[1]!,
      name: match[1]!,
      x: Number(match[5]),
      y: Number(match[6]),
      width: Number(match[3]),
      height: Number(match[4]),
      scale: 1,
      primary: Boolean(match[2]),
    });
  }
  if (displays.length > 0) {
    if (!displays.some((display) => display.primary)) {
      displays[0] = { ...displays[0]!, primary: true };
    }
    return displays;
  }
  return fallbackSize
    ? [
        {
          id: "primary",
          x: 0,
          y: 0,
          width: fallbackSize.width,
          height: fallbackSize.height,
          scale: 1,
          primary: true,
        },
      ]
    : [];
}

/** AppleScript prints `{0, 0, 1920, 1080}` (Finder desktop bounds). */
export function parseMacDisplay(
  output: string,
  fallbackSize?: { readonly width: number; readonly height: number },
): ReadonlyArray<DesktopUseDisplay> {
  const numbers = output.match(/-?\d+/g);
  if (numbers && numbers.length >= 4) {
    const [x1, y1, x2, y2] = numbers.slice(0, 4).map(Number) as [number, number, number, number];
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    if (width > 0 && height > 0) {
      return [
        {
          id: "primary",
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width,
          height,
          scale: 1,
          primary: true,
        },
      ];
    }
  }
  return fallbackSize
    ? [
        {
          id: "primary",
          x: 0,
          y: 0,
          width: fallbackSize.width,
          height: fallbackSize.height,
          scale: 1,
          primary: true,
        },
      ]
    : [];
}

export interface WindowsScreenRecord {
  readonly id?: unknown;
  readonly primary?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
}

export function parseWindowsDisplays(
  output: string,
  fallbackSize?: { readonly width: number; readonly height: number },
): ReadonlyArray<DesktopUseDisplay> {
  const records = parseJsonRecords<WindowsScreenRecord>(output);
  const displays: Array<DesktopUseDisplay> = [];
  for (const record of records) {
    const width = Number(record.width);
    const height = Number(record.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      continue;
    }
    displays.push({
      id:
        typeof record.id === "string" && record.id.length > 0
          ? record.id
          : `display-${displays.length}`,
      x: Number.isFinite(Number(record.x)) ? Number(record.x) : 0,
      y: Number.isFinite(Number(record.y)) ? Number(record.y) : 0,
      width,
      height,
      scale: 1,
      primary: record.primary === true,
    });
  }
  if (displays.length > 0) {
    if (!displays.some((display) => display.primary)) {
      displays[0] = { ...displays[0]!, primary: true };
    }
    return displays;
  }
  return fallbackSize
    ? [
        {
          id: "primary",
          x: 0,
          y: 0,
          width: fallbackSize.width,
          height: fallbackSize.height,
          scale: 1,
          primary: true,
        },
      ]
    : [];
}

/** `xdotool getmouselocation --shell` prints `X=…` and `Y=…`. */
export function parseXdotoolCursor(output: string): { x: number; y: number } | null {
  const x = /^X=(-?\d+)$/m.exec(output)?.[1];
  const y = /^Y=(-?\d+)$/m.exec(output)?.[1];
  if (x === undefined || y === undefined) return null;
  return { x: Number(x), y: Number(y) };
}

/** `cliclick p` and the PowerShell probe both print `x,y`. */
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

interface RawWindow {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly appName?: unknown;
  readonly app?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly active?: unknown;
}

export function parseJsonWindows(output: string): ReadonlyArray<DesktopUseWindow> {
  const records = parseJsonRecords<RawWindow>(output);
  const windows: Array<DesktopUseWindow> = [];
  for (const record of records) {
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (title.length === 0) continue;
    windows.push({
      id:
        typeof record.id === "string" && record.id.length > 0
          ? record.id
          : typeof record.id === "number"
            ? String(record.id)
            : `window-${windows.length}`,
      title,
      ...(typeof record.appName === "string"
        ? { appName: record.appName }
        : typeof record.app === "string"
          ? { appName: record.app }
          : {}),
      x: Number.isFinite(Number(record.x)) ? Number(record.x) : 0,
      y: Number.isFinite(Number(record.y)) ? Number(record.y) : 0,
      width: Number.isFinite(Number(record.width)) ? Number(record.width) : 0,
      height: Number.isFinite(Number(record.height)) ? Number(record.height) : 0,
      active: record.active === true,
    });
  }
  return windows;
}

function parseJsonRecords<T>(output: string): ReadonlyArray<T> {
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as ReadonlyArray<T>;
    if (parsed !== null && typeof parsed === "object") return [parsed as T];
    return [];
  } catch {
    return [];
  }
}
