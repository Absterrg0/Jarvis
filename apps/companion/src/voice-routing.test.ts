import { assert, describe, it } from "@effect/vitest";

import { companionContinuationTarget } from "./voice-routing.ts";

const target = { projectId: "project-1", threadId: "thread-1" } as const;

describe("companion voice routing", () => {
  it("continues only when continuation mode has an exact target", () => {
    assert.deepEqual(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Continue with the migration",
        attentionTarget: target,
      }),
      target,
    );
    assert.isUndefined(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Continue with the migration",
      }),
    );
  });

  it("starts explicitly routed provider work instead of contaminating the previous task", () => {
    assert.isUndefined(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Use Codex to implement the new dashboard",
        attentionTarget: target,
      }),
    );
    assert.isUndefined(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Spin up Claude Code to review the last change",
        attentionTarget: target,
      }),
    );
  });
});
