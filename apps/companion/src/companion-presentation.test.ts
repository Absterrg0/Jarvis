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
    assert.notInclude(companionPresentationStyle("setup"), "jarvis-flow");
  });
});
