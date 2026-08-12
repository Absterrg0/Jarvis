import { assert, describe, it } from "@effect/vitest";

import { canStartCapture, takeCaptureForReadyBubble } from "./bubble-state.ts";

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
});
