import { assert, describe, it } from "@effect/vitest";

import { jarvisPresentationStateForKind, jarvisPresentationStates } from "./voice-presentation.ts";

describe("Jarvis presentation states", () => {
  it("maps native capture and task beats into the stable visual vocabulary", () => {
    assert.deepEqual(jarvisPresentationStates, [
      "idle",
      "listening",
      "transcribing",
      "working",
      "waiting",
      "speaking",
      "error",
    ]);
    assert.equal(jarvisPresentationStateForKind(undefined), "idle");
    assert.equal(jarvisPresentationStateForKind("arming"), "listening");
    assert.equal(jarvisPresentationStateForKind("capturing"), "listening");
    assert.equal(jarvisPresentationStateForKind("review"), "transcribing");
    assert.equal(jarvisPresentationStateForKind("started"), "working");
    assert.equal(jarvisPresentationStateForKind("attention"), "waiting");
    assert.equal(jarvisPresentationStateForKind("speaking"), "speaking");
    assert.equal(jarvisPresentationStateForKind("completed"), "idle");
    assert.equal(jarvisPresentationStateForKind("error"), "error");
  });
});
