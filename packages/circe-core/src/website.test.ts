import { describe, expect, it } from "vite-plus/test";

import { circeWebsiteUrl } from "./website.ts";

describe("grounded website launches", () => {
  it("resolves an app-owned alias only when the user said it", () => {
    expect(circeWebsiteUrl("YouTube", "Open YouTube")).toBe("https://www.youtube.com/");
    expect(circeWebsiteUrl("YouTube", "open you tube please")).toBe("https://www.youtube.com/");
    expect(circeWebsiteUrl("yt", "open yt")).toBe("https://www.youtube.com/");
    expect(circeWebsiteUrl("YouTube", "open Google")).toBeNull();
  });

  it("refuses a URL the user never spoke, even for a named site", () => {
    // Regression: "Open YouTube" must not launch a hallucinated target.
    expect(circeWebsiteUrl("https://evil.example", "Open YouTube")).toBeNull();
    expect(circeWebsiteUrl("evil.example", "Open YouTube")).toBeNull();
  });

  it("accepts an explicit URL or domain present in the utterance", () => {
    expect(circeWebsiteUrl("https://example.com", "open https://example.com")).toBe(
      "https://example.com/",
    );
    expect(circeWebsiteUrl("example.com", "go to example.com now")).toBe("https://example.com/");
    expect(circeWebsiteUrl("http://example.com", "open http://example.com")).toBe(
      "http://example.com/",
    );
    expect(circeWebsiteUrl("https://example.com/path", "open https://example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("refuses a URL that is not the one the user named", () => {
    expect(circeWebsiteUrl("https://evil.example", "open example.com")).toBeNull();
    expect(circeWebsiteUrl("https://example.company", "open example.com")).toBeNull();
    expect(circeWebsiteUrl("https://example.com/evil", "open example.com/good")).toBeNull();
    // A longer host that starts with the named one is a different site.
    expect(circeWebsiteUrl("https://example.com", "open example.com.evil")).toBeNull();
  });

  it("matches a named domain as a full token", () => {
    expect(circeWebsiteUrl("youtube.com", "open youtube.com")).toBe("https://youtube.com/");
    expect(circeWebsiteUrl("example.com", "open example.com.")).toBe("https://example.com/");
  });

  it("does not match an alias inside another word or a longer domain", () => {
    expect(circeWebsiteUrl("yt", "python tutorial")).toBeNull();
    expect(circeWebsiteUrl("yt", "open yt.example")).toBeNull();
  });

  it("fails closed on credentials, non-http schemes, and missing source", () => {
    expect(
      circeWebsiteUrl("https://user:pass@example.com", "https://user:pass@example.com"),
    ).toBeNull();
    expect(circeWebsiteUrl("javascript:alert(1)", "javascript:alert(1)")).toBeNull();
    expect(circeWebsiteUrl("YouTube")).toBeNull();
    expect(circeWebsiteUrl("https://example.com")).toBeNull();
  });
});
