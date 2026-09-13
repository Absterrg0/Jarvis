import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as DesktopDriverModule from "./DesktopDriver.ts";
import { readPngSize } from "./parsers.ts";

// Explicit opt-in only: this captures the desktop of the process running the test.
const TestLayer = DesktopDriverModule.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-desktop-use-driver-" })),
  Layer.provide(NodeServices.layer),
);

describe.runIf(process.env.ARIS_DESKTOP_USE_LIVE_TEST === "1")("opt-in native capture", () => {
  it.layer(TestLayer)("DesktopDriver (live)", (it) => {
    it.effect("reports a platform and captures a readable PNG when pixels exist", () =>
      Effect.gen(function* () {
        const driver = yield* DesktopDriverModule.DesktopDriver;
        const status = yield* driver.getStatus();
        expect(["darwin", "linux", "win32"]).toContain(status.platform);
        if (!status.available) {
          expect(status.reason).toBeDefined();
          return;
        }
        expect(status.displays.length).toBeGreaterThan(0);
        const capture = yield* driver.capture({});
        expect(readPngSize(capture.png)).not.toBeNull();
        expect(capture.display.width).toBeGreaterThan(0);
      }),
    );
  });
});
