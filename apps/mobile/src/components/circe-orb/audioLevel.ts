/**
 * Audio level signal pipeline for the Circe orb.
 *
 *   raw meter (0..1 amplitude) -> noise floor -> response curve
 *   -> attack/release smoothing -> clamped 0..1 level
 *
 * Silence settles gracefully, speech onset reacts quickly, release is slower
 * so the visual never jitters. Tiny microphone noise stays below the floor.
 */

export const ORB_NOISE_FLOOR = 0.06;
export const ORB_ATTACK = 0.55;
export const ORB_RELEASE = 0.12;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Kills sub-floor noise, rescales the remainder to fill 0..1. */
export function applyNoiseFloor(level: number, floor: number = ORB_NOISE_FLOOR): number {
  const clamped = clamp01(level);
  if (clamped <= floor) return 0;
  return (clamped - floor) / (1 - floor);
}

/** Expands mid levels so quiet speech stays visible without blowing out loud input. */
export function responseCurve(level: number): number {
  return Math.sqrt(clamp01(level));
}

export interface LevelSmoother {
  /** Current smoothed level. */
  readonly value: number;
  /** Push a new normalized sample, returns the updated smoothed level. */
  readonly push: (sample: number) => number;
}

export function createLevelSmoother(
  attack: number = ORB_ATTACK,
  release: number = ORB_RELEASE,
): LevelSmoother {
  let current = 0;
  return {
    get value() {
      return current;
    },
    push(sample: number) {
      const target = clamp01(sample);
      const rate = target > current ? attack : release;
      current += (target - current) * rate;
      if (Math.abs(target - current) < 0.0005) current = target;
      return current;
    },
  };
}

export interface OrbIntensity {
  /** Overall energy driving glow, bloom, and scale. */
  readonly energy: number;
  /** Waveform amplitude multiplier. */
  readonly waveAmp: number;
  /** Bloom radius multiplier. */
  readonly bloom: number;
}

export function mapAudioToOrbIntensity(level: number): OrbIntensity {
  const energy = clamp01(level);
  return {
    energy,
    waveAmp: 0.25 + energy * 0.75,
    bloom: 1 + energy * 0.35,
  };
}
