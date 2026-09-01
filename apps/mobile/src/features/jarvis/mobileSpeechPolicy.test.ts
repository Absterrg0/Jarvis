import { describe, expect, it } from "@effect/vitest";
import {
  mobileSpeechKindForPresentation,
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
});
