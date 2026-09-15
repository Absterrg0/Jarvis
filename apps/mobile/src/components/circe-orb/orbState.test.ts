import { describe, expect, it } from "vite-plus/test";

import { resolveOrbParams } from "./orbState";

describe("orb state params", () => {
  it("keeps listening more expressive than idle", () => {
    const idle = resolveOrbParams("idle");
    const listening = resolveOrbParams("listening");
    expect(listening.fieldAlpha).toBeGreaterThan(idle.fieldAlpha);
    expect(listening.fieldAmplitude).toBeGreaterThan(idle.fieldAmplitude);
    expect(listening.rimIntensity).toBeGreaterThan(idle.rimIntensity);
    expect(listening.bloomIntensity).toBeGreaterThan(idle.bloomIntensity);
    expect(listening.energyResponse).toBeGreaterThan(idle.energyResponse);
  });

  it("drifts slowly at rest and faster while listening", () => {
    const idle = resolveOrbParams("idle");
    const listening = resolveOrbParams("listening");
    // One full migration should take many seconds. A cycle measured in tenths
    // of a second reads as a loop rather than as drift.
    expect(idle.fieldCycleSeconds).toBeGreaterThanOrEqual(9);
    expect(listening.fieldCycleSeconds).toBeLessThan(idle.fieldCycleSeconds);
    expect(listening.fieldCycleSeconds).toBeGreaterThan(3);
  });

  it("drives thinking through the shell, not through loud fibers", () => {
    const thinking = resolveOrbParams("thinking");
    const listening = resolveOrbParams("listening");
    expect(thinking.energyResponse).toBeLessThan(listening.energyResponse);
    expect(thinking.fieldAmplitude).toBeLessThan(listening.fieldAmplitude);
    // The shell still moves faster than at rest.
    expect(thinking.rimIntensity).toBeGreaterThan(resolveOrbParams("idle").rimIntensity);
  });

  it("keeps the hero frame free of grain", () => {
    // Idle and the welcome screen are the static frame the design is judged on.
    expect(resolveOrbParams("idle").particleAmount).toBe(0);
  });

  it("reduces motion to stillness while keeping the light on", () => {
    const listening = resolveOrbParams("listening", { reducedMotion: true });
    expect(listening.motionScale).toBe(0);
    expect(listening.fieldCycleSeconds).toBe(Number.POSITIVE_INFINITY);
    expect(listening.rimIntensity).toBeGreaterThan(0);
    expect(listening.bloomIntensity).toBeGreaterThan(0);

    const idle = resolveOrbParams("idle", { reducedMotion: true });
    expect(idle.bloomIntensity).toBeLessThan(listening.bloomIntensity);
  });
});
