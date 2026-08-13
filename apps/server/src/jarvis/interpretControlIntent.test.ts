import { describe, expect, it } from "@effect/vitest";

import { interpretControlIntent } from "./interpretControlIntent.ts";

describe("interpretControlIntent", () => {
  it.each([
    ["also add regression tests", "steer"],
    ["actually use sqlite instead", "steer"],
    ["after that update the documentation", "queue"],
    ["when that is done run the full suite", "queue"],
    ["stop that task", "interrupt"],
    ["what is it doing right now", "status"],
    ["do that last run in the Fable project", "reroute"],
    ["run the same task again in Payments", "reroute"],
  ] as const)("interprets %s as %s", (utterance, action) => {
    expect(interpretControlIntent(utterance).action).toBe(action);
  });

  it("keeps ordinary work as a new task", () => {
    expect(interpretControlIntent("fix the failing authentication tests")).toEqual({
      action: "new-task",
      instruction: "fix the failing authentication tests",
    });
  });

  it("focuses a named project without starting a coding task", () => {
    expect(interpretControlIntent("switch me to the Fable project")).toEqual({
      action: "focus-project",
    });
  });

  it("extracts the useful correction without conversational scaffolding", () => {
    expect(interpretControlIntent("Oh wait, also add regression tests for the parser")).toEqual({
      action: "steer",
      instruction: "add regression tests for the parser",
    });
    expect(interpretControlIntent("After that, update the documentation")).toEqual({
      action: "queue",
      instruction: "update the documentation",
    });
  });
});
