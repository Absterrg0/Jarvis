// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { resolveOrbParams } from "./orbState";

const orbDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

/** Every production renderer file. Excludes tests, by construction. */
const RENDERER_FILES = [
  "CirceOrb.tsx",
  "OrbBase.tsx",
  "OrbGlow.tsx",
  "OrbParticles.tsx",
  "OrbShell.tsx",
  "OrbVolume.tsx",
  "RibbonField.tsx",
] as const;

function rendererSource(): string {
  return RENDERER_FILES.map((file) =>
    NodeFS.readFileSync(NodePath.join(orbDir, file), "utf8"),
  ).join("\n");
}

describe("orb state params", () => {
  it("keeps listening more expressive than idle", () => {
    const idle = resolveOrbParams("idle");
    const listening = resolveOrbParams("listening");
    expect(listening.fieldAlpha).toBeGreaterThan(idle.fieldAlpha);
    expect(listening.fieldAmplitude).toBeGreaterThan(idle.fieldAmplitude);
    expect(listening.rimIntensity).toBeGreaterThan(idle.rimIntensity);
    expect(listening.bloomIntensity).toBeGreaterThan(idle.bloomIntensity);
    expect(listening.volumeIntensity).toBeGreaterThan(idle.volumeIntensity);
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

  it("consumes every state parameter in a production renderer", () => {
    // An earlier revision defined parameters that no renderer read, so the
    // tuning surface gave the impression of control without changing anything.
    // Every key returned here must be referenced by a real renderer file.
    const source = rendererSource();
    for (const key of Object.keys(resolveOrbParams("idle"))) {
      expect(source, `${key} has no consumer in the renderer`).toContain(`params.${key}`);
    }
  });
});
