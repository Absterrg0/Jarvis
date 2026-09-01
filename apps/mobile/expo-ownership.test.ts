import { describe, expect, it } from "vite-plus/test";

import { JARVIS_MOBILE_SLUG, resolveExpoOwnership } from "./expo-ownership.ts";

describe("mobile Expo ownership", () => {
  it("does not carry upstream Expo identity into a fresh checkout", () => {
    expect(resolveExpoOwnership({})).toEqual({ slug: JARVIS_MOBILE_SLUG });
  });

  it("enables OTA only when a Jarvis-owned project is configured", () => {
    expect(
      resolveExpoOwnership({
        JARVIS_EXPO_OWNER: "abstergo",
        JARVIS_EXPO_PROJECT_ID: "jarvis-preview-project",
      }),
    ).toEqual({
      slug: JARVIS_MOBILE_SLUG,
      owner: "abstergo",
      projectId: "jarvis-preview-project",
      updatesUrl: "https://u.expo.dev/jarvis-preview-project",
    });
  });

  it("trims configured values and ignores empty values", () => {
    expect(
      resolveExpoOwnership({
        JARVIS_EXPO_OWNER: "  ",
        JARVIS_EXPO_PROJECT_ID: "  ",
      }),
    ).toEqual({ slug: JARVIS_MOBILE_SLUG });
  });
});
