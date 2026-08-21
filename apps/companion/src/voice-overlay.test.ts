import { assert, describe, it } from "@effect/vitest";

import {
  estimatedVoiceReviewLines,
  voiceOverlayAutoHideDelay,
  voiceOverlaySpeechGraceDelay,
  voiceOverlaySize,
  voiceOverlaySizeForStatus,
  voiceReviewOverlayMaximumHeight,
} from "./voice-overlay.ts";

describe("voice overlay layout", () => {
  it("keeps short final transcripts in the compact command strip", () => {
    assert.equal(
      voiceOverlaySizeForStatus({ kind: "review", detail: "Review the current implementation." }),
      voiceOverlaySize,
    );
    assert.equal(voiceOverlaySizeForStatus({ kind: "listening" }), voiceOverlaySize);
    assert.equal(voiceOverlaySizeForStatus({ kind: "routing" }), voiceOverlaySize);
    assert.equal(voiceOverlaySizeForStatus({ kind: "error" }), voiceOverlaySize);
    assert.equal(voiceOverlaySizeForStatus({ kind: "interrupted" }), voiceOverlaySize);
  });

  it("grows only enough to make a long final transcript reviewable", () => {
    const detail =
      "Review each modified file and summarize the changes before continuing with the implementation.";
    const size = voiceOverlaySizeForStatus({ kind: "review", detail });

    assert.isAbove(estimatedVoiceReviewLines(detail), 2);
    assert.isAbove(size.height, voiceOverlaySize.height);
    assert.isAtMost(size.height, voiceReviewOverlayMaximumHeight);
  });

  it("dismisses terminal companion states instead of leaving a permanent HUD", () => {
    assert.equal(voiceOverlayAutoHideDelay({ kind: "started" }), 3_500);
    assert.isUndefined(voiceOverlayAutoHideDelay({ kind: "completed" }));
    assert.equal(voiceOverlaySpeechGraceDelay, 1_600);
    assert.equal(voiceOverlayAutoHideDelay({ kind: "error" }), 8_000);
    assert.equal(voiceOverlayAutoHideDelay({ kind: "interrupted" }), 1_200);
    assert.equal(voiceOverlayAutoHideDelay({ kind: "attention" }), 15_000);
    assert.isUndefined(voiceOverlayAutoHideDelay({ kind: "listening" }));
    assert.isUndefined(voiceOverlayAutoHideDelay({ kind: "routing" }));
  });

  it("grows a question or approval report so it can be read before dismissal", () => {
    const size = voiceOverlaySizeForStatus({
      kind: "attention",
      detail:
        "Which database should I use for the migration, should I run the full test suite before applying it, and do you want a rollback plan in the same pull request?",
    });

    assert.isAbove(size.height, voiceOverlaySize.height);
  });
});
