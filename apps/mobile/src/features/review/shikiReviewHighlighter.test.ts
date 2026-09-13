import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ReviewRenderableLineRow } from "./reviewModel";
import {
  highlightCodeSnippet,
  highlightReviewSelectedLines,
  highlightSourceFile,
} from "./shikiReviewHighlighter";

// Shiki's 500 ms per-line deadline can interrupt tokenization on a busy runner.
// Syntax assertions use a fixed clock; the timeout test advances it explicitly.
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("highlightSourceFile", () => {
  it("preserves one highlighted token row per source line without trailing newlines", async () => {
    const lines = [
      'const items = ["a"];',
      'expect(items).toEqual(["a"]);',
      "const next = items.map((item) => item.toUpperCase());",
      'expect(next).toContain("A");',
    ];

    const highlighted = await highlightSourceFile({
      path: "apps/mobile/src/example.ts",
      contents: lines.join("\n"),
      theme: "light",
    });

    expect(highlighted.map((tokens) => tokens.map((token) => token.content).join(""))).toEqual(
      lines,
    );
  });

  it("falls back to plain tokens for very long lines", async () => {
    const longLine = `const value = "${"a".repeat(1_100)}";`;

    const highlighted = await highlightSourceFile({
      path: "apps/mobile/src/example-long-line.ts",
      contents: longLine,
      theme: "light",
    });

    expect(highlighted).toEqual([
      [
        {
          content: longLine,
          color: null,
          fontStyle: null,
        },
      ],
    ]);
  });

  it.each(["source", "snippet"] as const)(
    "initializes without a warmup when %s highlighting runs first",
    async (first) => {
      vi.resetModules();
      const highlighter = await import("./shikiReviewHighlighter");
      const source = "const answer: number = 42;";
      const calls = {
        source: () =>
          highlighter.highlightSourceFile({
            path: "example.ts",
            contents: source,
            theme: "dark",
          }),
        snippet: () =>
          highlighter.highlightCodeSnippet({
            code: source,
            language: "ts",
            theme: "dark",
          }),
      };

      const highlighted = await calls[first]();
      expect(
        highlighted
          .flat()
          .map((token) => token.content)
          .join(""),
      ).toBe(source);
      expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
      expect(highlighted.flat().some((token) => token.content === "42")).toBe(true);
      expect(await calls[first === "source" ? "snippet" : "source"]()).toEqual(highlighted);
    },
  );

  it("preserves source text on timeout and fully highlights a subsequent call", async () => {
    const source = "const answer: number = 42;";
    let now = 0;
    vi.mocked(Date.now).mockImplementation(() => (now += 1_000));

    const interrupted = await highlightSourceFile({
      path: "example.ts",
      contents: source,
      theme: "dark",
    });
    expect(interrupted).toEqual([
      [
        {
          content: source,
          color: expect.any(String),
          fontStyle: expect.any(Number),
        },
      ],
    ]);

    vi.mocked(Date.now).mockReturnValue(0);
    const completed = await highlightSourceFile({
      path: "example.ts",
      contents: source,
      theme: "dark",
    });
    expect(
      completed
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(source);
    expect(completed.flat().some((token) => token.content === "42")).toBe(true);
    expect(await highlightCodeSnippet({ code: source, language: "ts", theme: "dark" })).toEqual(
      completed,
    );
  });

  it.each(["light", "dark"] as const)(
    "shares a lazily loaded language across concurrent %s callers",
    async (theme) => {
      vi.resetModules();
      const highlighter = await import("./shikiReviewHighlighter");
      const source = "answer = 42";
      const [file, snippet, review] = await Promise.all([
        highlighter.highlightSourceFile({ path: "example.py", contents: source, theme }),
        highlighter.highlightCodeSnippet({ code: source, language: "py", theme }),
        highlighter.highlightReviewSelectedLines({
          filePath: "example.py",
          theme,
          lines: [
            {
              kind: "line",
              id: "context",
              change: "context",
              content: source,
              oldLineNumber: 1,
              newLineNumber: 1,
              additionTokenIndex: null,
              deletionTokenIndex: null,
              comparison: null,
            },
          ],
        }),
      ]);

      expect(
        file
          .flat()
          .map((token) => token.content)
          .join(""),
      ).toBe(source);
      expect(file.flat().some((token) => token.content === "42" && token.color !== null)).toBe(
        true,
      );
      expect(snippet).toEqual(file);
      expect(review.context).toEqual(file[0]);
    },
  );
});

describe("highlightReviewSelectedLines", () => {
  it("adds word-alt diff emphasis for paired deletion and addition lines", async () => {
    const lines: ReviewRenderableLineRow[] = [
      {
        kind: "line",
        id: "delete-1",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
        content: "const before = 1;",
        additionTokenIndex: null,
        deletionTokenIndex: 0,
        comparison: { change: "add", tokenIndex: 0 },
      },
      {
        kind: "line",
        id: "add-1",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
        content: "const after = 2;",
        additionTokenIndex: 0,
        deletionTokenIndex: null,
        comparison: { change: "delete", tokenIndex: 0 },
      },
    ];

    const highlighted = await highlightReviewSelectedLines({
      filePath: "apps/mobile/src/example-inline-diff.txt",
      lines,
      theme: "light",
    });

    expect(highlighted["delete-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
    expect(highlighted["add-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
  });
});

describe("highlightCodeSnippet", () => {
  it("resolves language aliases and returns syntax-colored tokens", async () => {
    const source = "const answer: number = 42;";
    const highlighted = await highlightCodeSnippet({
      code: source,
      language: "ts",
      theme: "dark",
    });

    expect(
      highlighted
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(source);
    expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
  });
});
