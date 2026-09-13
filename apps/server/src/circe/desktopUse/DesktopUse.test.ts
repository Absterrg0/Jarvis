import { DesktopUsePolicyError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DesktopDriverModule from "./DesktopDriver.ts";
import * as DesktopUseModule from "./DesktopUse.ts";

const pngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 32,
  0, 0, 2, 88,
]);

const status = {
  available: true,
  platform: "linux" as const,
  backend: "linux-x11" as const,
  displays: [{ id: "primary", x: 0, y: 0, width: 800, height: 600, scale: 1, primary: true }],
  supports: { capture: true, pointer: true, keyboard: true, windows: true },
};

const captured: Array<string> = [];

const driverLayer = Layer.succeed(DesktopDriverModule.DesktopDriver, {
  getStatus: () => Effect.succeed(status),
  capture: () =>
    Effect.succeed({
      png: pngBytes,
      display: status.displays[0]!,
      cursor: { x: 3, y: 4 },
    }),
  input: (request) =>
    Effect.sync(() => {
      captured.push(request.action.type);
      return { x: 1, y: 2 };
    }),
  listWindows: () =>
    Effect.succeed([
      { id: "0x1", title: "Terminal", x: 0, y: 0, width: 10, height: 10, active: false },
    ]),
});

const TestLayer = Layer.effect(DesktopUseModule.DesktopUse, DesktopUseModule.make()).pipe(
  Layer.provide(driverLayer),
);

it.layer(TestLayer)("DesktopUse", (it) => {
  it.effect("capture base64-encodes the PNG and reports the cursor", () =>
    Effect.gen(function* () {
      const use = yield* DesktopUseModule.DesktopUse;
      const frame = yield* use.capture({});
      expect(frame.mimeType).toBe("image/png");
      expect(frame.width).toBe(800);
      expect(frame.height).toBe(600);
      expect(frame.displayId).toBe("primary");
      expect(frame.cursor).toEqual({ x: 3, y: 4 });
      expect(Buffer.from(frame.data, "base64")).toEqual(Buffer.from(pngBytes));
      expect(frame.capturedAt).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("input reaches the driver and returns the cursor", () =>
    Effect.gen(function* () {
      const use = yield* DesktopUseModule.DesktopUse;
      const result = yield* use.input({ action: { type: "pointer.click", x: 1, y: 2 } });
      expect(result.cursor).toEqual({ x: 1, y: 2 });
      expect(captured).toContain("pointer.click");
    }),
  );

  it.effect("rejects an invalid action before touching the driver", () =>
    Effect.gen(function* () {
      const use = yield* DesktopUseModule.DesktopUse;
      const error = yield* use
        .input({ action: { type: "keyboard.key", key: "not-a-key" } })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(DesktopUsePolicyError);
    }),
  );

  it.effect("listWindows returns the driver windows", () =>
    Effect.gen(function* () {
      const use = yield* DesktopUseModule.DesktopUse;
      const windows = yield* use.listWindows();
      expect(windows.map((window) => window.id)).toEqual(["0x1"]);
    }),
  );

  it.effect("subscribeFrames emits at least one frame and stops", () =>
    Effect.gen(function* () {
      const use = yield* DesktopUseModule.DesktopUse;
      const frames = yield* use
        .subscribeFrames({ intervalMs: 50 })
        .pipe(Stream.take(1), Stream.runCollect);
      expect([...frames]).toHaveLength(1);
    }),
  );
});
