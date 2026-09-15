import type { CirceOrbState } from "./types";

/**
 * The orb's art-direction surface.
 *
 * Deliberately small. An earlier version exposed a dozen knobs that varied by
 * state, several of which were never read by the renderer, which gave the
 * impression of control without changing anything. Everything here is consumed.
 *
 * One microphone `energy` value scales field amplitude, field speed, shell
 * brightness, bloom, and core warmth together, so the object responds as one
 * body rather than in disconnected parts.
 */
export interface OrbStateParams {
  /** Alpha multiplier for the fiber field. */
  readonly fieldAlpha: number;
  /** Amplitude multiplier for the fiber field. */
  readonly fieldAmplitude: number;
  /** Seconds for one full drift cycle. Larger is slower. */
  readonly fieldCycleSeconds: number;
  /** Shell (hull light) intensity. */
  readonly rimIntensity: number;
  /** Atmospheric bloom intensity. */
  readonly bloomIntensity: number;
  /** How much ember warmth bleeds into the dark core. */
  readonly coreWarmth: number;
  /** Grain visibility. Zero keeps the hero frame perfectly still. */
  readonly particleAmount: number;
  /** Global motion multiplier. Zero stills all continuous motion. */
  readonly motionScale: number;
  /** How strongly microphone energy feeds the field, shell, and bloom. */
  readonly energyResponse: number;
}

const BASE: Record<CirceOrbState, OrbStateParams> = {
  idle: {
    fieldAlpha: 0.55,
    fieldAmplitude: 0.85,
    fieldCycleSeconds: 11,
    rimIntensity: 0.8,
    bloomIntensity: 0.45,
    coreWarmth: 0.72,
    particleAmount: 0,
    motionScale: 1,
    energyResponse: 0.35,
  },
  listening: {
    fieldAlpha: 1,
    fieldAmplitude: 1.15,
    fieldCycleSeconds: 5,
    rimIntensity: 1.15,
    bloomIntensity: 0.8,
    coreWarmth: 0.8,
    particleAmount: 0.9,
    motionScale: 1.15,
    energyResponse: 1,
  },
  thinking: {
    // Concentration reads as interior work and a faster shell traversal, not
    // as loud fibers, so the field slows while the shell keeps moving.
    fieldAlpha: 0.7,
    fieldAmplitude: 0.8,
    fieldCycleSeconds: 9,
    rimIntensity: 1.05,
    bloomIntensity: 0.55,
    coreWarmth: 0.82,
    particleAmount: 0.6,
    motionScale: 0.75,
    energyResponse: 0.15,
  },
  speaking: {
    fieldAlpha: 0.9,
    fieldAmplitude: 1.25,
    fieldCycleSeconds: 6,
    rimIntensity: 1.25,
    bloomIntensity: 0.85,
    coreWarmth: 0.68,
    particleAmount: 0.9,
    motionScale: 1.05,
    energyResponse: 0.9,
  },
  success: {
    fieldAlpha: 1,
    fieldAmplitude: 1,
    fieldCycleSeconds: 12,
    rimIntensity: 1.4,
    bloomIntensity: 0.95,
    coreWarmth: 0.6,
    particleAmount: 0.5,
    motionScale: 0.9,
    energyResponse: 0.25,
  },
  error: {
    fieldAlpha: 0.35,
    fieldAmplitude: 0.55,
    fieldCycleSeconds: 8,
    rimIntensity: 0.6,
    bloomIntensity: 0.35,
    coreWarmth: 0.35,
    particleAmount: 0.15,
    motionScale: 0.7,
    energyResponse: 0.15,
  },
};

export function resolveOrbParams(
  state: CirceOrbState,
  options?: { readonly reducedMotion?: boolean },
): OrbStateParams {
  const params = BASE[state];
  if (options?.reducedMotion !== true) return params;
  return {
    ...params,
    motionScale: 0,
    fieldCycleSeconds: Number.POSITIVE_INFINITY,
  };
}
