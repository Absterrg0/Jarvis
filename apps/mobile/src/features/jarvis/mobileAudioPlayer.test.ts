import { describe, expect, it, vi } from "vite-plus/test";

import { releaseMobileAudioPlayer } from "./mobileAudioPlayer";

describe("mobile Jarvis audio player", () => {
  it("stops playback without replacing the native source with null", () => {
    const pause = vi.fn();
    const replace = vi.fn();
    const player = { pause, replace };

    releaseMobileAudioPlayer(player);

    expect(pause).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });
});
