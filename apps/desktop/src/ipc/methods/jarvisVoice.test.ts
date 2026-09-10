import { describe, expect, it, vi } from "vite-plus/test";

import { ensureMacMicrophonePermission } from "./jarvisVoice.ts";

describe("Jarvis microphone permission preflight", () => {
  it("accepts an already granted permission without prompting", async () => {
    const ask = vi.fn(async () => true);
    await expect(
      ensureMacMicrophonePermission({
        getMediaAccessStatus: () => "granted",
        askForMediaAccess: ask,
      }),
    ).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks only for a not-determined permission", async () => {
    const ask = vi.fn(async () => true);
    await expect(
      ensureMacMicrophonePermission({
        getMediaAccessStatus: () => "not-determined",
        askForMediaAccess: ask,
      }),
    ).resolves.toBe(true);
    expect(ask).toHaveBeenCalledWith("microphone");
  });

  it("rejects denied and restricted permissions without prompting", async () => {
    for (const status of ["denied", "restricted"] as const) {
      const ask = vi.fn(async () => true);
      await expect(
        ensureMacMicrophonePermission({
          getMediaAccessStatus: () => status,
          askForMediaAccess: ask,
        }),
      ).resolves.toBe(false);
      expect(ask).not.toHaveBeenCalled();
    }
  });
});
