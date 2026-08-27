import { describe, expect, it } from "vite-plus/test";

import { classifySpokenRequest } from "./classifySpokenRequest.ts";

describe("classifySpokenRequest", () => {
  it.each([
    "Can you please check out Alertify?",
    "Please inspect the deployment",
    "Review the current status",
    "Tell me why the build failed",
  ])("keeps %s behind approval-required mutation", (utterance) => {
    expect(classifySpokenRequest(utterance)).toBe("inspection");
  });

  it.each([
    "Fix the Alertify deployment",
    "Check Alertify and update its dependencies",
    "Please implement the new behavior",
  ])("recognizes an explicit change in %s", (utterance) => {
    expect(classifySpokenRequest(utterance)).toBe("change");
  });
});
