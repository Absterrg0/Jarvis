import { assert, describe, it } from "@effect/vitest";

import { companionPresentationStyle, companionSetupCopyScript } from "./companion-presentation.ts";

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

  it("names the host action as a browser workspace", () => {
    assert.include(companionSetupCopyScript("setup"), "Open workspace in browser");
    assert.equal(companionSetupCopyScript("voice"), "");
  });
});
