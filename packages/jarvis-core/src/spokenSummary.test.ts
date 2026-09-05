import { describe, expect, it } from "vite-plus/test";

import { normalizeSpokenText, selectSpokenSummary } from "./spokenSummary.ts";

describe("spokenSummary", () => {
  it("replaces code fences instead of reading punctuation aloud", () => {
    expect(normalizeSpokenText("Done. ```ts\nconst x = 1;\n``` See below.")).toContain(
      "The code details are waiting in your workspace.",
    );
    expect(normalizeSpokenText("**Bold** [link](url)")).not.toMatch(/[*[\]`]/);
  });

  it("keeps short results whole and truncates long ones at a sentence", () => {
    expect(selectSpokenSummary("All done.", 460)).toBe("All done.");
    const long = `${"First sentence is short. "} ${"Second sentence adds detail. "} ${"Third ".repeat(200)}`;
    const summary = selectSpokenSummary(long, 460);
    expect(summary.length).toBeLessThanOrEqual(460);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("never exceeds the budget even when a sentence ends at the boundary", () => {
    // Period lands exactly where the old search window could select it.
    const text = `${"x".repeat(117)}. ${"y".repeat(500)}`;
    for (const maximum of [120, 121, 122, 200, 460]) {
      const summary = selectSpokenSummary(text, maximum);
      expect(summary.length).toBeLessThanOrEqual(maximum);
    }
  });
});
