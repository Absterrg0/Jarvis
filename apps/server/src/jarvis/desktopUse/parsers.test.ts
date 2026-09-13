import { describe, expect, it } from "vite-plus/test";

import {
  parseCommaCursor,
  parseJsonWindows,
  parseMacDisplay,
  parseWindowsDisplays,
  parseWmctrlWindows,
  parseXdotoolCursor,
  parseXrandrDisplays,
  readPngSize,
} from "./parsers.ts";

const pngOf = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
};

describe("readPngSize", () => {
  it("reads IHDR dimensions", () => {
    expect(readPngSize(pngOf(2560, 1440))).toEqual({ width: 2560, height: 1440 });
  });

  it("rejects non-PNG and malformed headers", () => {
    expect(readPngSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    const notIhdr = pngOf(10, 10);
    notIhdr.set([0x62, 0x4b, 0x47, 0x44], 12);
    expect(readPngSize(notIhdr)).toBeNull();
  });
});

describe("parseXrandrDisplays", () => {
  const output = [
    "Screen 0: minimum 320 x 200, current 4480 x 1440, maximum 16384 x 16384",
    "eDP-1 connected primary 2560x1440+0+0 (normal left inverted right x axis y axis) 344mm x 194mm",
    "DP-1 connected 1920x1080+2560+360 (normal left inverted right x axis y axis) 527mm x 296mm",
    "HDMI-1 disconnected (normal left inverted right x axis y axis)",
  ].join("\n");

  it("extracts connected outputs, geometry, and the primary flag", () => {
    const displays = parseXrandrDisplays(output);
    expect(displays).toHaveLength(2);
    expect(displays[0]).toEqual({
      id: "eDP-1",
      name: "eDP-1",
      x: 0,
      y: 0,
      width: 2560,
      height: 1440,
      scale: 1,
      primary: true,
    });
    expect(displays[1]?.x).toBe(2560);
    expect(displays[1]?.primary).toBe(false);
  });

  it("falls back to a primary display when nothing parses", () => {
    expect(parseXrandrDisplays("garbage", { width: 1280, height: 720 })).toEqual([
      { id: "primary", x: 0, y: 0, width: 1280, height: 720, scale: 1, primary: true },
    ]);
  });
});

describe("parseMacDisplay", () => {
  it("parses Finder desktop bounds", () => {
    expect(parseMacDisplay("{0, 0, 1512, 982}")).toEqual([
      { id: "primary", x: 0, y: 0, width: 1512, height: 982, scale: 1, primary: true },
    ]);
  });
});

describe("parseWindowsDisplays", () => {
  it("parses an AllScreens JSON array", () => {
    const displays = parseWindowsDisplays(
      JSON.stringify([
        { id: "\\\\.\\DISPLAY1", primary: true, x: 0, y: 0, width: 1920, height: 1080 },
        { id: "\\\\.\\DISPLAY2", primary: false, x: 1920, y: 0, width: 2560, height: 1440 },
      ]),
    );
    expect(displays).toHaveLength(2);
    expect(displays[0]?.primary).toBe(true);
    expect(displays[1]?.width).toBe(2560);
  });

  it("returns an empty list for unparseable output", () => {
    expect(parseWindowsDisplays("not json")).toEqual([]);
  });
});

describe("cursor parsers", () => {
  it("reads xdotool shell output", () => {
    expect(parseXdotoolCursor("X=101\nY=202\nSCREEN=0\nWINDOW=123\n")).toEqual({ x: 101, y: 202 });
    expect(parseXdotoolCursor("nope")).toBeNull();
  });

  it("reads comma output from cliclick and PowerShell", () => {
    expect(parseCommaCursor("101,202")).toEqual({ x: 101, y: 202 });
    expect(parseCommaCursor("101, 202")).toEqual({ x: 101, y: 202 });
  });
});

describe("parseWmctrlWindows", () => {
  it("parses id, geometry, class, and title", () => {
    const windows = parseWmctrlWindows(
      [
        "0x03a00007  0 1234  10 20 800 600 Terminal.Gnome host terminal — bash",
        "0x04e00003  0 5678  0  0  1920 1080 firefox.Firefox host Mozilla Firefox",
      ].join("\n"),
    );
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({
      id: "0x03a00007",
      title: "terminal — bash",
      appName: "Terminal.Gnome",
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      active: false,
    });
  });

  it("ignores short lines", () => {
    expect(parseWmctrlWindows("0x1 0 1")).toEqual([]);
  });
});

describe("parseJsonWindows", () => {
  it("accepts a single object and an array, mapping app and active", () => {
    const windows = parseJsonWindows(
      JSON.stringify({
        id: 42,
        title: "Safari",
        app: "Safari",
        x: 1,
        y: 2,
        width: 3,
        height: 4,
        active: true,
      }),
    );
    expect(windows).toEqual([
      {
        id: "42",
        title: "Safari",
        appName: "Safari",
        x: 1,
        y: 2,
        width: 3,
        height: 4,
        active: true,
      },
    ]);
    expect(parseJsonWindows(JSON.stringify([]))).toEqual([]);
    expect(parseJsonWindows("garbage")).toEqual([]);
  });
});
