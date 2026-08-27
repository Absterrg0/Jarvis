import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  JARVIS_LINUX_ELECTRON_ARGS,
  applyJarvisLinuxOzoneCommandLineSwitches,
} from "./jarvis-linux-electron-args.ts";

describe("JARVIS_LINUX_ELECTRON_ARGS", () => {
  it("keeps packaging argv and runtime ozone switches on one list", () => {
    assert.deepEqual(JARVIS_LINUX_ELECTRON_ARGS, [
      "--no-sandbox",
      "--ozone-platform=x11",
      "--disable-gpu-compositing",
    ]);
    const appendSwitch = vi.fn();
    applyJarvisLinuxOzoneCommandLineSwitches({ appendSwitch }, "x11");
    assert.deepEqual(appendSwitch.mock.calls, [
      ["ozone-platform", "x11"],
      ["disable-gpu-compositing"],
    ]);
  });
});
