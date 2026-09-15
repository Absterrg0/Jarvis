import { describe, expect, it } from "vite-plus/test";

import { resolveOrbParams } from "./orbState";

describe("orb state params", () => {
  it("keeps listening more expressive than idle", () => {
    const idle = resolveOrbParams("idle");
    const listening = resolveOrbParams("listening");
    expect(listening.bloomOpacity).toBeGreaterThan(idle.bloomOpacity);
    expect(listening.massIntensity).toBeGreaterThan(idle.massIntensity);
    expect(listening.waveAmp).toBeGreaterThan(idle.waveAmp);
    expect(listening.rimBoost).toBeGreaterThan(idle.rimBoost);
  });

  it("keeps a faint fiber field in every mode", () => {
    // The reference keeps strands visible at rest. No mode may drop to zero,
    // or the orb reverts to a bare ball on a flat background.
    for (const state of [
      "idle",
      "listening",
      "thinking",
      "speaking",
      "success",
      "error",
    ] as const) {
      expect(resolveOrbParams(state).waveAmp).toBeGreaterThan(0);
      expect(resolveOrbParams(state).strandOpacity).toBeGreaterThan(0);
    }
  });

  it("drives thinking through the interior and the rim, not through audio", () => {
    const thinking = resolveOrbParams("thinking");
    const idle = resolveOrbParams("idle");
    // Concentration is interior work plus a fast rim traversal, so thinking
    // must not respond to level the way listening does.
    expect(thinking.internalActivity).toBeGreaterThan(idle.internalActivity);
    expect(thinking.rimPhaseSpeed).toBeGreaterThan(idle.rimPhaseSpeed);
    expect(thinking.strandSpeedScale).toBeLessThan(idle.strandSpeedScale);
    expect(thinking.glowResponse).toBeLessThan(idle.glowResponse);
  });

  it("reduces motion to stillness while keeping state glow", () => {
    const listening = resolveOrbParams("listening", { reducedMotion: true });
    expect(listening.motionSpeed).toBe(0);
    expect(listening.breatheScale).toBe(1);
    expect(listening.strandSpeedScale).toBe(0);
    expect(listening.rimPhaseSpeed).toBe(0);
    expect(listening.bloomOpacity).toBeGreaterThan(0);

    const idle = resolveOrbParams("idle", { reducedMotion: true });
    expect(idle.bloomOpacity).toBeLessThan(listening.bloomOpacity);
  });
});
