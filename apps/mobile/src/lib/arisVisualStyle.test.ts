import { describe, expect, it } from "vite-plus/test";

import { ARIS_CONTROL_RADIUS, ARIS_PANEL_RADIUS } from "./layoutMetrics";
import { MOBILE_SECTION_LABEL, MOBILE_TYPOGRAPHY } from "./typography";

describe("ARIS mobile visual system", () => {
  it("uses sharp 3px controls and 4px panels", () => {
    expect(ARIS_CONTROL_RADIUS).toBe(3);
    expect(ARIS_PANEL_RADIUS).toBe(4);
  });

  it("labels sections with a mono uppercase micro style", () => {
    expect(MOBILE_SECTION_LABEL).toMatchObject({
      fontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
      lineHeight: MOBILE_TYPOGRAPHY.micro.lineHeight,
      letterSpacing: 1.1,
      textTransform: "uppercase",
      fontWeight: "600",
    });
  });
});
