import { assert, describe, it } from "@effect/vitest";

import {
  canStartCapture,
  queuedBubbleCaptureEvent,
  takeCaptureForReadyBubble,
} from "./bubble-state.ts";

describe("Jarvis bubble capture lifecycle", () => {
  it("holds a hotkey capture until the bubble document has registered its listener", () => {
    assert.deepEqual(takeCaptureForReadyBubble({ bubbleReady: false, capturePending: true }), {
      capturePending: true,
      shouldStart: false,
    });
  });

  it("delivers a queued capture exactly once once the bubble is ready", () => {
    assert.deepEqual(takeCaptureForReadyBubble({ bubbleReady: true, capturePending: true }), {
      capturePending: false,
      shouldStart: true,
    });
    assert.deepEqual(takeCaptureForReadyBubble({ bubbleReady: true, capturePending: false }), {
      capturePending: false,
      shouldStart: false,
    });
  });

  it("does not start a second recorder while one capture is in flight", () => {
    assert.isFalse(canStartCapture(true));
    assert.isTrue(canStartCapture(false));
  });

  it("renders a release that happened before the first voice document became ready", () => {
    assert.deepEqual(
      queuedBubbleCaptureEvent({
        bubbleReady: false,
        capturePending: true,
        phase: "checking",
      }),
      { capturePending: true, event: undefined },
    );
    assert.deepEqual(
      queuedBubbleCaptureEvent({
        bubbleReady: true,
        capturePending: true,
        phase: "checking",
      }),
      { capturePending: false, event: "stop" },
    );
  });
});
