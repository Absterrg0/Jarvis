import { describe, expect, it } from "vite-plus/test";

import { JARVIS_BRAND_NAME, JARVIS_BRAND_TAGLINE, JARVIS_MARK_SRC } from "./JarvisBrand";

describe("Jarvis brand", () => {
  it("uses a dedicated mark and Jarvis-facing labels", () => {
    expect(JARVIS_MARK_SRC).toBe("/jarvis-mark.png");
    expect(JARVIS_BRAND_NAME).toBe("JARVIS");
    expect(JARVIS_BRAND_TAGLINE).toBe("Command interface");
    expect(`${JARVIS_BRAND_NAME} ${JARVIS_BRAND_TAGLINE}`).not.toMatch(/\bT3\b/iu);
  });
});
