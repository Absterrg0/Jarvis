import { describe, expect, it } from "vite-plus/test";

import {
  parseCommaCursor,
  parseJsonWindows,
  parseNativeDisplays,
  parseWlrDisplays,
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
    "Monitors: 2",
    "0: +*eDP-1 2560/344x1440/194+0+0 eDP-1",
    "1: +DP-1 1920/527x1080/296+2560+360 DP-1",
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

  it("does not invent a display for malformed output", () => {
    expect(parseXrandrDisplays("garbage")).toEqual([]);
  });
  it("preserves negative monitor origins", () => {
    expect(parseXrandrDisplays("0: +DP-2 1920/500x1080/300-1920-100 DP-2")[0]).toMatchObject({
      x: -1920,
      y: -100,
    });
  });
});

describe("native catalogs", () => {
  it("accepts native geometry and refuses missing identities", () => {
    const display = { id: "42", x: -100, y: 0, width: 100, height: 80, scale: 2, primary: true };
    expect(parseNativeDisplays(JSON.stringify([display]))).toEqual([display]);
    expect(parseNativeDisplays(JSON.stringify([{ width: 100, height: 80 }]))).toEqual([]);
  });
  it("handles disabled Wayland outputs and scaled rotated monitors", () => {
    expect(
      parseWlrDisplays(
        JSON.stringify([
          { name: "off", enabled: false },
          {
            name: "DP-1",
            enabled: true,
            position: { x: -800, y: 0 },
            scale: 2,
            transform: "90",
            modes: [{ width: 1200, height: 1600, current: true }],
          },
        ]),
      ),
    ).toEqual([{ id: "DP-1", x: -800, y: 0, width: 800, height: 600, scale: 2, primary: true }]);
  });
});

describe("cursor parsers", () => {
  it("reads xdotool shell output", () => {
    expect(parseXdotoolCursor("X=101\nY=202\nSCREEN=0\nWINDOW=123\n")).toEqual({ x: 101, y: 202 });
    expect(parseXdotoolCursor("nope")).toBeNull();
  });

  it("reads native comma output", () => {
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
  it("accepts a single object and an array, preserving identity and active state", () => {
    const windows = parseJsonWindows(
      JSON.stringify({
        id: "42",
        title: "Safari",
        appName: "Safari",
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
    expect(parseJsonWindows(JSON.stringify({ title: "No identity" }))).toEqual([]);
  });
});
