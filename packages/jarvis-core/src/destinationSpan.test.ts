import { describe, expect, it } from "vite-plus/test";

import {
  deleteSourceSpans,
  findSourceQuoteSpans,
  isDeletableSpan,
  normalizeDestinationPhrase,
  sourceSpanOverlapsQuotes,
  stripDestinationQuotes,
} from "./destinationSpan.ts";

describe("exact source spans", () => {
  it("accepts ordered in-bounds spans", () => {
    expect(isDeletableSpan("Check auth in Rivvl", { start: 14, end: 19 })).toBe(true);
    expect(isDeletableSpan("Check auth in Rivvl", { start: 0, end: 19 })).toBe(true);
  });

  it("rejects reversed, empty, fractional, and out-of-bounds spans", () => {
    const source = "Check auth";
    expect(isDeletableSpan(source, { start: 5, end: 5 })).toBe(false);
    expect(isDeletableSpan(source, { start: 6, end: 5 })).toBe(false);
    expect(isDeletableSpan(source, { start: -1, end: 5 })).toBe(false);
    expect(isDeletableSpan(source, { start: 0, end: 11 })).toBe(false);
    expect(isDeletableSpan(source, { start: 0.5, end: 5 })).toBe(false);
    expect(isDeletableSpan(source, { start: 0, end: Number.NaN })).toBe(false);
  });

  it("counts Unicode offsets as UTF-16 code units like slice", () => {
    const source = "Vérify café ☕ status";
    const start = source.indexOf("café");
    expect(isDeletableSpan(source, { start, end: start + "café".length })).toBe(true);
    expect(source.slice(start, start + "café".length)).toBe("café");
    const emoji = source.indexOf("☕");
    expect(isDeletableSpan(source, { start: emoji, end: emoji + "☕".length })).toBe(true);
  });
});

describe("span deletion", () => {
  it("deletes exactly the cited ranges and joins the survivors", () => {
    // Boundary spaces survive the raw join; resolveJarvisInstruction trims
    // the joined ends as boundary hygiene.
    expect(deleteSourceSpans("Check auth in Rivvl", [{ start: 11, end: 19 }])).toBe("Check auth ");
    expect(deleteSourceSpans("In Rivvl, fix the header", [{ start: 0, end: 10 }])).toBe(
      "fix the header",
    );
  });

  it("preserves untouched characters byte-for-byte, including inner spacing", () => {
    expect(deleteSourceSpans("Fix a  b in Fable", [{ start: 9, end: 17 }])).toBe("Fix a  b ");
    expect(deleteSourceSpans("Check   auth\tin Rivvl", [{ start: 13, end: 21 }])).toBe(
      "Check   auth\t",
    );
  });

  it("keeps neighboring spaces where the wrapper sat mid-sentence", () => {
    expect(deleteSourceSpans("Fix auth in Rivvl today", [{ start: 9, end: 17 }])).toBe(
      "Fix auth  today",
    );
  });

  it("deletes nothing for an empty span list", () => {
    expect(deleteSourceSpans("Fix auth", [])).toBe("Fix auth");
  });

  it("rejects overlapping, unsorted, and out-of-bounds spans", () => {
    expect(
      deleteSourceSpans("Check auth in Rivvl", [
        { start: 0, end: 12 },
        { start: 6, end: 18 },
      ]),
    ).toBeUndefined();
    expect(
      deleteSourceSpans("Check auth in Rivvl", [
        { start: 10, end: 18 },
        { start: 0, end: 5 },
      ]),
    ).toBeUndefined();
    expect(deleteSourceSpans("Check auth", [{ start: 0, end: 99 }])).toBeUndefined();
    expect(deleteSourceSpans("Check auth", [{ start: 5, end: 5 }])).toBeUndefined();
  });

  it("allows adjacent spans that only touch", () => {
    expect(
      deleteSourceSpans("In Rivvl, fix it", [
        { start: 0, end: 3 },
        { start: 3, end: 9 },
      ]),
    ).toBe(" fix it");
  });
});

describe("shared destination normalization", () => {
  it("folds case, punctuation, and quotes the same way on both sides", () => {
    expect(normalizeDestinationPhrase('Check PRs in "Rivvl"')).toBe("check prs in rivvl");
    expect(normalizeDestinationPhrase("  In\u00a0Rivvl, ")).toBe("in rivvl");
    expect(stripDestinationQuotes('"Rivvl"')).toBe("Rivvl");
    expect(stripDestinationQuotes("'Atlas'")).toBe("Atlas");
  });

  it("preserves Unicode letters while folding", () => {
    // NFKD plus mark-stripping folds accents; caseless letters survive.
    expect(normalizeDestinationPhrase("Café")).toBe("cafe");
    expect(normalizeDestinationPhrase("Ω")).toBe("ω");
  });
});

describe("shared quote spans", () => {
  it("finds quoted literals with UTF-16 offsets", () => {
    const source = 'Explain "stop auth task" in Rivvl.';
    const quotes = findSourceQuoteSpans(source);
    expect(quotes).toHaveLength(1);
    expect(source.slice(quotes[0]!.start, quotes[0]!.end)).toBe('"stop auth task"');
    expect(sourceSpanOverlapsQuotes(9, 24, quotes)).toBe(true);
    expect(sourceSpanOverlapsQuotes(27, 36, quotes)).toBe(false);
  });

  it("finds nothing in unquoted turns", () => {
    expect(findSourceQuoteSpans("Test auth in Rivvl.")).toEqual([]);
  });
});
