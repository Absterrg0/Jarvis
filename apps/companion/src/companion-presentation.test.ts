import { assert, describe, it } from "@effect/vitest";

import { companionPresentationStyle } from "./companion-presentation.ts";

describe("Companion presentation contract", () => {
  it("uses a compact signal instrument with a reduced-motion fallback", () => {
    const style = companionPresentationStyle("voice");
    assert.include(style, 'data-presentation-state="listening"');
    assert.include(style, 'data-presentation-state="working"');
    assert.include(style, 'data-presentation-state="speaking"');
    assert.include(style, "prefers-reduced-motion:reduce");
    assert.notInclude(style, "infinite");
    assert.include(style, "signal-draw");
    assert.include(style, "voice-fallback");
    assert.include(style, 'data-visual-fallback="visible"');
    assert.notInclude(style, "presence-orb");
    assert.notInclude(style, "radial-gradient");
    assert.notInclude(style, "backdrop-filter");
  });

  it("keeps setup solid and hierarchical rather than decorative", () => {
    const setup = companionPresentationStyle("setup");
    assert.include(setup, ".connection-state");
    assert.include(setup, ".defaults-panel");
    assert.include(setup, ".tray-button");
    assert.notInclude(setup, "gradient");
    assert.notInclude(setup, "backdrop-filter");
  });
});
