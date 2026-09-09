import { describe, expect, it } from "vite-plus/test";

import { STANDARD_THEME_CARDS, previewColorsOf } from "./ThemePreviewCircles";

describe("ARIS standard theme preview", () => {
  it("shows amber action colors instead of inherited indigo", () => {
    const card = STANDARD_THEME_CARDS.find((entry) => entry.id === "default");
    expect(card).toBeDefined();
    expect(card?.label).toBe("ARIS");

    const light = previewColorsOf(card!, "light");
    const dark = previewColorsOf(card!, "dark");

    expect(light?.messageAction).toBe("#96600a");
    expect(light?.canvas).toBe("#faf7f1");
    expect(light?.accent).toBe("#eae2d1");
    expect(dark?.messageAction).toBe("#c99a2e");
    expect(dark?.canvas).toBe("#16181b");
    expect(dark?.accent).toBe("#23272c");

    expect(light?.messageAction).not.toBe("#4f46e5");
    expect(dark?.messageAction).not.toBe("#8b9cff");
  });
});
