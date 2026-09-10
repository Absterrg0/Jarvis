import { describe, expect, it } from "@effect/vitest";
import {
  mobileSpeechKindForPresentation,
  mobileSpeechText,
  shouldSpeakMobile,
  type MobileSpeechKind,
} from "./mobileSpeechPolicy";

describe("mobile Jarvis speech policy", () => {
  it.each([
    "acknowledgement",
    "needs-input",
    "approval-needed",
    "completed",
    "failed",
  ] satisfies MobileSpeechKind[])("speaks the %s outcome", (kind: MobileSpeechKind) => {
    expect(shouldSpeakMobile(kind)).toBe(true);
  });

  it("keeps progress visual", () => {
    expect(shouldSpeakMobile("progress")).toBe(false);
  });

  it.each([
    ["waiting-for-input", "needs-input"],
    ["approval-needed", "approval-needed"],
    ["completed", "completed"],
    ["failed", "failed"],
  ] as const)("maps the %s presentation to %s", (presentation, speech) => {
    expect(mobileSpeechKindForPresentation(presentation)).toBe(speech);
  });

  it("speaks a completion summary instead of the whole report", () => {
    expect(
      mobileSpeechText({
        kind: "completed",
        text: "The auth review is done. Three issues found. First, tokens never expire. Second, the refresh path lacks tests. Third, error messages leak internals.",
      }),
    ).toBe("The auth review is done. Three issues found.");
  });

  it("speaks approvals and questions in full", () => {
    const text = "Should I run the migration against the production database now?";
    expect(mobileSpeechText({ kind: "approval-needed", text })).toBe(text);
    expect(mobileSpeechText({ kind: "waiting-for-input", text })).toBe(text);
  });

  it("never speaks code fences or Markdown raw", () => {
    expect(
      mobileSpeechText({
        kind: "completed",
        text: "Done. ```ts\nconst token = leak();\n``` **Check** [the logs](x).",
      }),
    ).not.toContain("```");
  });
});
