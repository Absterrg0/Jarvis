import { describe, expect, it } from "vite-plus/test";

import {
  applyNoiseFloor,
  clamp01,
  createLevelSmoother,
  mapAudioToOrbIntensity,
  responseCurve,
} from "./audioLevel";

describe("orb audio pipeline", () => {
  it("clamps non-finite and out-of-range input", () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
  });

  it("holds silence below the noise floor and rescales above it", () => {
    expect(applyNoiseFloor(0)).toBe(0);
    expect(applyNoiseFloor(0.05)).toBe(0);
    expect(applyNoiseFloor(0.06)).toBe(0);
    expect(applyNoiseFloor(1)).toBe(1);
    const mid = applyNoiseFloor(0.53);
    expect(mid).toBeGreaterThan(0.49);
    expect(mid).toBeLessThan(0.51);
  });

  it("expands quiet levels without clipping loud ones", () => {
    expect(responseCurve(0)).toBe(0);
    expect(responseCurve(1)).toBe(1);
    expect(responseCurve(0.25)).toBe(0.5);
  });

  it("attacks fast and releases slow", () => {
    const smoother = createLevelSmoother(0.55, 0.12);
    expect(smoother.value).toBe(0);
    const onset = smoother.push(1);
    expect(onset).toBeGreaterThan(0.5);
    const decay = smoother.push(0);
    expect(decay).toBeLessThan(onset);
    expect(decay).toBeGreaterThan(0.3);
    for (let index = 0; index < 200; index += 1) smoother.push(0);
    expect(smoother.value).toBe(0);
  });

  it("settles exactly instead of hovering near zero", () => {
    const smoother = createLevelSmoother();
    smoother.push(0.2);
    for (let index = 0; index < 200; index += 1) smoother.push(0);
    expect(smoother.value).toBe(0);
  });

  it("maps level to glow, waves, and bloom monotonically", () => {
    const quiet = mapAudioToOrbIntensity(0);
    expect(quiet).toMatchObject({ energy: 0, waveAmp: 0.25, bloom: 1 });
    const loud = mapAudioToOrbIntensity(1);
    expect(loud.energy).toBeGreaterThan(quiet.energy);
    expect(loud.waveAmp).toBeGreaterThan(quiet.waveAmp);
    expect(loud.bloom).toBeGreaterThan(quiet.bloom);
    expect(mapAudioToOrbIntensity(2).energy).toBe(1);
  });
});
