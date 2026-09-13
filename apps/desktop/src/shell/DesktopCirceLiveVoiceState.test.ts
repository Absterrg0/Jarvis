import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { CIRCE_LIVE_VOICE_STATE_CHANNEL } from "../ipc/channels.ts";
import { createDesktopCirceLiveVoiceStateBridge } from "./DesktopCirceLiveVoiceState.ts";

describe("DesktopCirceLiveVoiceState bridge", () => {
  it("keeps the last valid report and ignores malformed ones", () => {
    let reportListener: ((event: unknown, raw: unknown) => void) | undefined;
    const ipcMain = {
      on: vi.fn((channel: string, listener: (event: unknown, raw: unknown) => void) => {
        if (channel === CIRCE_LIVE_VOICE_STATE_CHANNEL) reportListener = listener;
      }),
      removeListener: vi.fn(),
    };
    const bridge = createDesktopCirceLiveVoiceStateBridge(ipcMain);
    expect(bridge.getState()).toBeNull();

    const seen: Array<{ enabled: boolean; active: boolean; status: string }> = [];
    const unsubscribe = bridge.onState((state) => seen.push(state));

    reportListener?.({}, { enabled: true, active: true, status: "live" });
    expect(bridge.getState()).toEqual({ enabled: true, active: true, status: "live" });
    expect(seen).toEqual([{ enabled: true, active: true, status: "live" }]);

    reportListener?.({}, { enabled: "yes" });
    expect(bridge.getState()).toEqual({ enabled: true, active: true, status: "live" });

    unsubscribe();
    bridge.dispose();
    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      CIRCE_LIVE_VOICE_STATE_CHANNEL,
      expect.any(Function),
    );
  });
});
