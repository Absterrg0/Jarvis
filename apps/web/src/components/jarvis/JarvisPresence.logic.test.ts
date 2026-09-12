import { describe, expect, it } from "vite-plus/test";

import { jarvisPresenceMode } from "./JarvisPresence.logic";

describe("Jarvis presence", () => {
  it("projects truthful manager state into presence modes", () => {
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: null,
        error: null,
      }),
    ).toBe("idle");
    expect(
      jarvisPresenceMode({
        listening: true,
        submitting: true,
        activeTaskState: "running",
        error: null,
      }),
    ).toBe("listening");
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: true,
        activeTaskState: null,
        error: null,
      }),
    ).toBe("working");
    for (const state of ["waiting-for-input", "waiting-for-approval"] as const) {
      expect(
        jarvisPresenceMode({
          listening: false,
          submitting: false,
          activeTaskState: state,
          error: null,
        }),
      ).toBe("attention");
    }
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: "running",
        error: "Request failed",
      }),
    ).toBe("error");
    expect(
      jarvisPresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: "ready",
        error: null,
      }),
    ).toBe("idle");
  });
});
