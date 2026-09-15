import type { CirceOrbState } from "./types";

/**
 * Per-mode rendering parameters.
 *
 * `massIntensity` is the interior refraction pass: strands bent inside the
 * sphere. `waveAmp` is overall fiber presence; the reference keeps a faint
 * field at rest, so no mode hides the fibers entirely. `rimPhaseSpeed` drives
 * how quickly the rim highlight travels around the sphere, which is how
 * thinking communicates concentration without a spinner.
 */
export interface OrbStateParams {
  /** Ambient bloom strength. */
  readonly bloomOpacity: number;
  /** Multiplier on bloom radius. */
  readonly bloomRadiusScale: number;
  /** Rim brightness multiplier. */
  readonly rimBoost: number;
  /** Interior refraction pass strength. */
  readonly massIntensity: number;
  /** Fiber presence, 0..1. */
  readonly waveAmp: number;
  /** Multiplier on fiber alpha. */
  readonly strandOpacity: number;
  /** Multiplier on fiber amplitude. */
  readonly strandAmplitudeScale: number;
  /** Multiplier on fiber drift speed. */
  readonly strandSpeedScale: number;
  /** Multiplier on interior strand amplitude. */
  readonly internalActivity: number;
  /** Rim highlight travel speed, in revolutions per traversal period. */
  readonly rimPhaseSpeed: number;
  /** Number of microscopic particles. */
  readonly particleAmount: number;
  /** How luminous the sphere's interior is. */
  readonly warmth: number;
  /** How deep the copper falls off toward the hull. */
  readonly edgeDepth: number;
  /** Global motion speed. Zero stills all continuous motion. */
  readonly motionSpeed: number;
  /** Sphere breathing scale. */
  readonly breatheScale: number;
  /** How strongly audio level feeds bloom and rim. */
  readonly glowResponse: number;
  /** Legacy halo opacity, retained for the aura rings. */
  readonly haloOpacity: number;
}

const BASE: Record<CirceOrbState, OrbStateParams> = {
  idle: {
    bloomOpacity: 0.5,
    bloomRadiusScale: 1,
    rimBoost: 0.85,
    massIntensity: 0.25,
    waveAmp: 0.35,
    strandOpacity: 0.85,
    strandAmplitudeScale: 0.9,
    strandSpeedScale: 1,
    internalActivity: 0.3,
    rimPhaseSpeed: 1,
    particleAmount: 0.4,
    warmth: 1,
    edgeDepth: 0.95,
    motionSpeed: 1,
    breatheScale: 1,
    glowResponse: 0.4,
    haloOpacity: 0.45,
  },
  listening: {
    bloomOpacity: 0.95,
    bloomRadiusScale: 1.08,
    rimBoost: 1.25,
    massIntensity: 0.8,
    waveAmp: 1,
    strandOpacity: 1.15,
    strandAmplitudeScale: 1.18,
    strandSpeedScale: 1.5,
    internalActivity: 0.9,
    rimPhaseSpeed: 1.6,
    particleAmount: 1,
    warmth: 1.1,
    edgeDepth: 0.86,
    motionSpeed: 1.3,
    breatheScale: 1,
    glowResponse: 1,
    haloOpacity: 0.6,
  },
  thinking: {
    bloomOpacity: 0.6,
    bloomRadiusScale: 0.96,
    rimBoost: 1.05,
    massIntensity: 1,
    waveAmp: 0.5,
    strandOpacity: 0.7,
    strandAmplitudeScale: 0.8,
    strandSpeedScale: 0.35,
    internalActivity: 1.3,
    rimPhaseSpeed: 2.4,
    particleAmount: 0.7,
    warmth: 0.95,
    edgeDepth: 0.86,
    motionSpeed: 0.55,
    breatheScale: 1,
    glowResponse: 0.2,
    haloOpacity: 0.5,
  },
  speaking: {
    bloomOpacity: 1,
    bloomRadiusScale: 1.12,
    rimBoost: 1.35,
    massIntensity: 0.6,
    waveAmp: 0.9,
    strandOpacity: 1.2,
    strandAmplitudeScale: 1.3,
    strandSpeedScale: 1.3,
    internalActivity: 0.6,
    rimPhaseSpeed: 1.4,
    particleAmount: 1,
    warmth: 1.15,
    edgeDepth: 0.86,
    motionSpeed: 1.15,
    breatheScale: 1.01,
    glowResponse: 1,
    haloOpacity: 0.7,
  },
  success: {
    bloomOpacity: 1.1,
    bloomRadiusScale: 1.2,
    rimBoost: 1.5,
    massIntensity: 0.5,
    waveAmp: 0.6,
    strandOpacity: 1,
    strandAmplitudeScale: 1,
    strandSpeedScale: 0.9,
    internalActivity: 0.5,
    rimPhaseSpeed: 1.2,
    particleAmount: 0.8,
    warmth: 1.2,
    edgeDepth: 0.7,
    motionSpeed: 0.8,
    breatheScale: 1.02,
    glowResponse: 0.3,
    haloOpacity: 0.75,
  },
  error: {
    bloomOpacity: 0.42,
    bloomRadiusScale: 0.9,
    rimBoost: 0.7,
    massIntensity: 0.2,
    waveAmp: 0.22,
    strandOpacity: 0.6,
    strandAmplitudeScale: 0.6,
    strandSpeedScale: 0.7,
    internalActivity: 0.18,
    rimPhaseSpeed: 0.8,
    particleAmount: 0.2,
    warmth: 0.82,
    edgeDepth: 0.92,
    motionSpeed: 0.7,
    breatheScale: 1,
    glowResponse: 0.2,
    haloOpacity: 0.3,
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
    motionSpeed: 0,
    breatheScale: 1,
    strandSpeedScale: 0,
    rimPhaseSpeed: 0,
    internalActivity: params.internalActivity * 0.35,
  };
}
