import { assert, describe, it } from "@effect/vitest";

import {
  estimatedVoiceReviewLines,
  setupWindowBounds,
  setupWindowSize,
  voiceOverlayAutoHideDelay,
  voiceOverlaySpeechGraceDelay,
  voiceOverlayActionForKind,
  voiceOverlayBounds,
  voiceOverlaySize,
  voiceOverlaySizeForStatus,
  voiceReviewOverlayMaximumHeight,
} from "./voice-overlay.ts";

describe("voice overlay layout", () => {
  it("preserves normal overlay and setup placement on a full work area", () => {
    const area = { x: 0, y: 0, width: 1920, height: 1080 };

    assert.deepEqual(voiceOverlayBounds(area), {
      x: 698,
      y: 944,
      width: voiceOverlaySize.width,
      height: voiceOverlaySize.height,
    });
    assert.deepEqual(setupWindowBounds(area), {
      x: 692,
      y: 253,
      width: setupWindowSize.width,
      height: setupWindowSize.height,
    });
  });

  it("keeps both windows inside short and narrow work areas", () => {
    const area = { x: 40, y: 24, width: 360, height: 220 };
    const voice = voiceOverlayBounds(area, { ...voiceOverlaySize, height: 136 });
    const setup = setupWindowBounds(area);

    assert.isAtLeast(voice.x, area.x + 16);
    assert.isAtMost(voice.x + voice.width, area.x + area.width - 16);
    assert.isAtLeast(voice.y, area.y + 16);
    assert.isAtMost(voice.y + voice.height, area.y + area.height - 16);
    assert.isAtLeast(setup.x, area.x + 16);
    assert.isAtMost(setup.x + setup.width, area.x + area.width - 16);
    assert.isAtLeast(setup.y, area.y + 16);
    assert.isAtMost(setup.y + setup.height, area.y + area.height - 16);
    assert.isBelow(setup.width, setupWindowSize.width);
    assert.isBelow(setup.height, setupWindowSize.height);
  });

  it("relaxes the margin only when a work area is smaller than both margins", () => {
    const bounds = setupWindowBounds({ x: 10, y: 20, width: 20, height: 24 });

    assert.equal(bounds.width, 1);
    assert.equal(bounds.height, 1);
    assert.isAtLeast(bounds.x, 10);
    assert.isAtMost(bounds.x + bounds.width, 30);
    assert.isAtLeast(bounds.y, 20);
    assert.isAtMost(bounds.y + bounds.height, 44);
  });

  it("only exposes actions that have a Companion bridge implementation", () => {
    assert.equal(voiceOverlayActionForKind("completed"), "open-host");
    assert.equal(voiceOverlayActionForKind("attention"), "open-host");
    assert.equal(voiceOverlayActionForKind("speaking"), "stop-speaking");
    assert.isUndefined(voiceOverlayActionForKind("listening"));
    assert.isUndefined(voiceOverlayActionForKind("started"));
  });

  it("keeps short final transcripts in the compact command strip", () => {
    assert.equal(
      voiceOverlaySizeForStatus({ kind: "review", detail: "Review the current implementation." }),
      voiceOverlaySize,
    );
    assert.equal(voiceOverlaySizeForStatus({ kind: "listening" }), voiceOverlaySize);
    assert.equal(voiceOverlaySizeForStatus({ kind: "routing" }), voiceOverlaySize);
    assert.equal(voiceOverlaySizeForStatus({ kind: "speaking" }), voiceOverlaySize);
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
    assert.isUndefined(voiceOverlayAutoHideDelay({ kind: "speaking" }));
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
