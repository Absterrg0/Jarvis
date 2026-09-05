import { describe, expect, it } from "vite-plus/test";

import { resolveSpokenApprovalDecision, resolveVoiceConfirmation } from "./confirmation.ts";

describe("spoken confirmation negation", () => {
  it.each([
    "do not allow it",
    "don't approve it",
    "don't proceed",
    "can't proceed",
    "don't use that",
    "never allow that",
    "cannot approve it",
  ])("declines a negated approval answer instead of consenting: %s", (utterance) => {
    expect(resolveSpokenApprovalDecision(utterance)).toBe("decline");
  });

  it.each([
    "that's not right",
    "don't proceed",
    "can't proceed",
    "don't use that",
    "no, not that one",
    "never mind",
  ])("declines a negated voice confirmation instead of accepting: %s", (utterance) => {
    expect(resolveVoiceConfirmation(utterance)).toBe("decline");
  });

  it.each(["yes, allow it", "allow it", "go ahead", "yes, approve it"])(
    "still accepts an unnegated confirmation: %s",
    (utterance) => {
      expect(resolveSpokenApprovalDecision(utterance)).toBe("accept");
    },
  );

  it.each([
    "should I approve it?",
    "allow it?",
    "maybe allow it",
    "allow it only if tests pass",
    "approve it if the build passes",
    "yes if tests pass",
    "do I allow it",
    "what should I approve",
  ])("leaves an ambiguous approval answer as clarification: %s", (utterance) => {
    expect(resolveSpokenApprovalDecision(utterance)).toBe("clarify");
  });
});
