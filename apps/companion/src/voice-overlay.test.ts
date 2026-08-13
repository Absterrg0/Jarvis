import { assert, describe, it } from "@effect/vitest";

import {
  estimatedVoiceReviewLines,
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
  });

  it("grows only enough to make a long final transcript reviewable", () => {
    const detail =
      "Review each modified file and summarize the changes before continuing with the implementation.";
    const size = voiceOverlaySizeForStatus({ kind: "review", detail });

    assert.isAbove(estimatedVoiceReviewLines(detail), 2);
    assert.isAbove(size.height, voiceOverlaySize.height);
    assert.isAtMost(size.height, voiceReviewOverlayMaximumHeight);
  });
});
