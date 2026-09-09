import { describe, expect, it } from "vite-plus/test";

import { createJarvisTurnTiming } from "./timing.ts";

function controlledClock(steps: ReadonlyArray<number>): () => number {
  let index = 0;
  return () => steps[Math.min(index++, steps.length - 1)] ?? 0;
}

describe("Jarvis turn timing", () => {
  it("measures elapsed time between two marks", () => {
    const timing = createJarvisTurnTiming(controlledClock([100, 160]));
    timing.mark("semantic-start");
    timing.mark("semantic-end");
    expect(timing.elapsed("semantic-start", "semantic-end")).toBe(60);
  });

  it("keeps the first write when a boundary repeats", () => {
    const timing = createJarvisTurnTiming(controlledClock([100, 200]));
    timing.mark("interpret");
    timing.mark("interpret");
    timing.mark("accept");
    expect(timing.record()["interpret"]).toBe(100);
    expect(timing.elapsed("interpret", "accept")).toBe(100);
  });

  it("reports undefined instead of zero for missing marks", () => {
    const timing = createJarvisTurnTiming(controlledClock([100]));
    timing.mark("semantic-start");
    expect(timing.elapsed("semantic-start", "director-end")).toBeUndefined();
    expect(timing.elapsed("missing", "semantic-start")).toBeUndefined();
  });
});
