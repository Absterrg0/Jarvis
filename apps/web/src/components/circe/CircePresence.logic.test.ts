import { describe, expect, it } from "vite-plus/test";

import { circePresenceMode } from "./CircePresence.logic";

describe("Circe presence", () => {
  it("projects truthful manager state into presence modes", () => {
    expect(
      circePresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: null,
        error: null,
      }),
    ).toBe("idle");
    expect(
      circePresenceMode({
        listening: true,
        submitting: true,
        activeTaskState: "running",
        error: null,
      }),
    ).toBe("listening");
    expect(
      circePresenceMode({
        listening: false,
        submitting: true,
        activeTaskState: null,
        error: null,
      }),
    ).toBe("working");
    for (const state of ["waiting-for-input", "waiting-for-approval"] as const) {
      expect(
        circePresenceMode({
          listening: false,
          submitting: false,
          activeTaskState: state,
          error: null,
        }),
      ).toBe("attention");
    }
    expect(
      circePresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: "running",
        error: "Request failed",
      }),
    ).toBe("error");
    expect(
      circePresenceMode({
        listening: false,
        submitting: false,
        activeTaskState: "ready",
        error: null,
      }),
    ).toBe("idle");
  });
});
