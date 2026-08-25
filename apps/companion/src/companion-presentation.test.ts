import { assert, describe, it } from "@effect/vitest";

import { companionPresentationStyle } from "./companion-presentation.ts";

describe("Companion presentation contract", () => {
  it("animates only active voice states and has a reduced-motion fallback", () => {
    const style = companionPresentationStyle("voice");
    assert.include(style, 'data-presentation-state="listening"');
    assert.include(style, 'data-presentation-state="working"');
    assert.include(style, 'data-presentation-state="speaking"');
    assert.include(style, 'data-presentation-state="idle"');
    assert.include(style, "prefers-reduced-motion:reduce");
    assert.notInclude(style, "infinite");
    assert.include(style, "780ms ease-out 1 both");
    assert.notInclude(companionPresentationStyle("setup"), "jarvis-flow");
  });

  it("keeps the resting lens static and gives setup one coherent status surface", () => {
    const voice = companionPresentationStyle("voice");
    assert.notInclude(voice, "will-change");
    assert.include(voice, 'data-presentation-state="waiting"');
    assert.include(voice, 'data-presentation-state="error"');
    assert.include(companionPresentationStyle("setup"), ".connection-state");
    assert.include(companionPresentationStyle("setup"), ".tray-button");
  });
});
