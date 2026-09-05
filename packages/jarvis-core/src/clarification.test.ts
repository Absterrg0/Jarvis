import { describe, expect, it } from "vite-plus/test";

import { isJarvisClarificationDiscard } from "./clarification.ts";

describe("shared clarification discard", () => {
  it.each(["cancel", "Cancel.", "never mind", "nevermind", "forget it", "stop", "no thanks"])(
    "exits any pending clarification: %s",
    (answer) => {
      expect(isJarvisClarificationDiscard(answer)).toBe(true);
    },
  );

  it.each(["no, use the second project", "stop the running task", "2", "rivvl", "yes"])(
    "keeps project answers and affirmations: %s",
    (answer) => {
      expect(isJarvisClarificationDiscard(answer)).toBe(false);
    },
  );
});
