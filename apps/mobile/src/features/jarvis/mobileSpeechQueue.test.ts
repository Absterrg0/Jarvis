import { describe, expect, it } from "vite-plus/test";

import { segmentMobileSpeech } from "./mobileSpeechQueue";

describe("mobile Jarvis speech segmentation", () => {
  it("starts with a short complete segment and preserves the presentation text", () => {
    const segments = segmentMobileSpeech(
      "Finished updating the tests. Two failures remain in the authentication suite.",
    );

    expect(segments).toEqual([
      "Finished updating the tests.",
      "Two failures remain in the authentication suite.",
    ]);
    expect(segments.join(" ")).toBe(
      "Finished updating the tests. Two failures remain in the authentication suite.",
    );
  });

  it("bounds long sentences and ignores empty speech", () => {
    const segments = segmentMobileSpeech(`Result ${"word ".repeat(100)}`);
    expect(segments.every((segment) => segment.length <= 240)).toBe(true);
    expect(segmentMobileSpeech("   ")).toEqual([]);
  });

  it("bounds an individual token longer than one speech segment", () => {
    const token = "x".repeat(600);
    const segments = segmentMobileSpeech(token);

    expect(segments.every((segment) => segment.length <= 240)).toBe(true);
    expect(segments.join("")).toBe(token);
  });
});
