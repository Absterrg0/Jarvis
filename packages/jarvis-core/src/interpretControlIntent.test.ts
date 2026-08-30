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

  it("keeps project discovery inside Jarvis instead of starting a coding task", () => {
    expect(interpretControlIntent("Can you tell me what projects are there?")).toEqual({
      action: "list-projects",
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
    expect(
      interpretControlIntent("In that Alertify request, please check if there are any PR's open."),
    ).toEqual({
      action: "queue",
      instruction: "check if there are any PR's open.",
    });
  });

  it("keeps provider changes as ordinary work instead of replacing a task", () => {
    expect(interpretControlIntent("actually document the Claude integration").action).toBe("steer");
    expect(interpretControlIntent("actually use Claude for the first task").action).toBe("steer");
  });
});
