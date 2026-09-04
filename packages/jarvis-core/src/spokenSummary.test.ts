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
});
