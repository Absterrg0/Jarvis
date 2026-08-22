import { assert, describe, it } from "@effect/vitest";

import { companionWebglScript, createCompanionWebglLifecycle } from "./companion-webgl.ts";

describe("Companion WebGL voice field", () => {
  it("cancels the frame loop when the voice state becomes idle or hidden", () => {
    let nextFrame = 0;
    let callback: ((timestamp: number) => void) | undefined;
    const cancelled: Array<number> = [];
    const lifecycle = createCompanionWebglLifecycle({
      requestFrame: (next) => {
        callback = next;
        return ++nextFrame;
      },
      cancelFrame: (frame) => cancelled.push(frame),
      draw: () => undefined,
      reducedMotion: () => false,
      visible: () => true,
    });

    lifecycle.setActive(true);
    assert.equal(nextFrame, 1);
    callback?.(16);
    assert.equal(nextFrame, 2);
    callback?.(34);
    assert.equal(nextFrame, 3);
    lifecycle.setActive(false);
    assert.deepEqual(cancelled, [3]);
    lifecycle.setActive(true);
    lifecycle.setVisible(false);
    assert.deepEqual(cancelled, [3, 4]);
  });

  it("keeps a static fallback for reduced motion and emits a bounded shader loop", () => {
    let requested = 0;
    const lifecycle = createCompanionWebglLifecycle({
      requestFrame: () => {
        requested += 1;
        return requested;
      },
      cancelFrame: () => undefined,
      draw: () => undefined,
      reducedMotion: () => true,
      visible: () => true,
    });
    lifecycle.setActive(true);
    assert.equal(requested, 0);

    const script = companionWebglScript("voice");
    assert.include(script, "webgl");
    assert.include(script, "requestAnimationFrame");
    assert.include(script, "cancelAnimationFrame");
    assert.include(script, "webglcontextlost");
    assert.include(script, "Math.min(window.devicePixelRatio||1,1.5)");
    assert.include(script, "data-presentation-state");
    assert.equal(companionWebglScript("setup"), "");
  });
});
