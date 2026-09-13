import { describe, expect, it } from "vite-plus/test";

import { CIRCE_MOBILE_SLUG, resolveExpoOwnership } from "./expo-ownership.ts";

describe("mobile Expo ownership", () => {
  it("does not carry upstream Expo identity into a fresh checkout", () => {
    expect(resolveExpoOwnership({})).toEqual({ slug: CIRCE_MOBILE_SLUG });
  });

  it("enables OTA only when a Circe-owned project is configured", () => {
    expect(
      resolveExpoOwnership({
        CIRCE_EXPO_OWNER: "abstergo",
        CIRCE_EXPO_PROJECT_ID: "circe-preview-project",
      }),
    ).toEqual({
      slug: CIRCE_MOBILE_SLUG,
      owner: "abstergo",
      projectId: "circe-preview-project",
      updatesUrl: "https://u.expo.dev/circe-preview-project",
    });
  });

  it("trims configured values and ignores empty values", () => {
    expect(
      resolveExpoOwnership({
        CIRCE_EXPO_OWNER: "  ",
        CIRCE_EXPO_PROJECT_ID: "  ",
      }),
    ).toEqual({ slug: CIRCE_MOBILE_SLUG });
  });
});
