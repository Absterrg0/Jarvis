import { describe, expect, it } from "vite-plus/test";

import { jarvisPresenceMode } from "./JarvisPresence.logic";

describe("Jarvis presence", () => {
  it("projects truthful manager and voice state into presence modes", () => {
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: null,
        error: null,
        nativeVoiceState: null,
      }),
    ).toBe("idle");
    expect(
      jarvisPresenceMode({
        listening: true,
        submitting: true,
        activeTaskState: "running",
        error: null,
        nativeVoiceState: { status: "ready", native: true },
      }),
    ).toBe("listening");
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: true,
        activeTaskState: null,
        error: null,
        nativeVoiceState: { status: "ready", native: true },
      }),
    ).toBe("working");
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: "running",
        error: null,
        nativeVoiceState: { status: "speaking", native: true },
      }),
    ).toBe("speaking");
    for (const state of ["waiting-for-input", "waiting-for-approval"] as const) {
      expect(
        jarvisPresenceMode({
          listening: false,
          submitting: false,
          activeTaskState: state,
          error: null,
          nativeVoiceState: { status: "ready", native: true },
        }),
      ).toBe("attention");
    }
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: "running",
        error: "Native voice failed",
        nativeVoiceState: { status: "speaking", native: true },
      }),
    ).toBe("error");
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: "ready",
        error: null,
        nativeVoiceState: { status: "ready", native: true },
      }),
    ).toBe("idle");
  });
});
