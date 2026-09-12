import { describe, expect, it } from "vite-plus/test";

import {
  isJarvisClarificationDiscard,
  jarvisClarificationAnswerHasCommandRemainder,
} from "./clarification.ts";

describe("shared clarification discard", () => {
  it.each([
    "cancel",
    "Cancel.",
    "never mind",
    "nevermind",
    "forget it",
    "stop",
    "no thanks",
    "start over",
    "not that one",
  ])("exits any pending clarification: %s", (answer) => {
    expect(isJarvisClarificationDiscard(answer)).toBe(true);
  });

  it.each(["no, use the second project", "stop the running task", "2", "rivvl", "yes"])(
    "keeps project answers and affirmations: %s",
    (answer) => {
      expect(isJarvisClarificationDiscard(answer)).toBe(false);
    },
  );
});

describe("clarification answer command remainder", () => {
  it.each([
    ["please check pull requests in alertify", "alertify"],
    ["Alright, so check the pull requests present in Ripple", "Ripple"],
    ["move the api task to backend", "backend"],
    ["in Rivvl, check the flaky tests", "Rivvl"],
  ])(
    "treats a matched mention that still owns a command as a fresh request: %s",
    (answer, matched) => {
      expect(jarvisClarificationAnswerHasCommandRemainder({ answer, matchedText: matched })).toBe(
        true,
      );
    },
  );

  it.each([
    ["rivvl", "rivvl"],
    ["I meant rival.", "rival."],
    ["use the Rivvl project", "rivvl"],
    ["the second one", "the second one"],
    ["yes", "yes"],
    ["which one is Rivvl", "Rivvl"],
  ])("keeps a pure target selection on the paused request: %s", (answer, matched) => {
    expect(jarvisClarificationAnswerHasCommandRemainder({ answer, matchedText: matched })).toBe(
      false,
    );
  });

  it("fails closed when the matcher consumed nothing", () => {
    expect(
      jarvisClarificationAnswerHasCommandRemainder({ answer: "anything", matchedText: "" }),
    ).toBe(true);
  });
});
