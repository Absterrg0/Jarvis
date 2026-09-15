/**
 * Orb palette and tuning.
 *
 * The defining property of this object is contrast: light lives at the
 * boundary and the centre absorbs it. The middle of the sphere must stay in
 * the `core` family. If it reads as bright copper, the render has failed
 * regardless of how good the shell looks.
 */
export const ORB_PALETTE = {
  /**
   * Absorbs light. Design system v1 places the dark body over the first ~70% of
   * the sphere radius, so the middle stays in this family and only the shell
   * carries color.
   */
  core: "#100E0D",
  coreWarm: "#151211",
  ember: "#1A100C",

  /** Shell ramp, read outward: deep copper, accent copper, peach, hot lip. */
  deep: "#6D3526",
  copper: "#E18A62",
  peach: "#FFD8BD",
  /** Only ever the thin lip or the right-edge specular flare. */
  hot: "#FFF4E9",

  /** Brand accent copper, for chrome that is not the orb. */
  accent: "#E08A63",
  accentBright: "#F0A078",
  accentDeep: "#A5482C",

  /** Surfaces the orb composites against. */
  midnight: "#0C0D0E",
  ivory: "#FCF9F4",
} as const;

export type OrbAppearance = "light" | "dark";

/** Hex (#RRGGBB) to a normalized rgba tuple for shader uniforms. */
export function rgbaOf(hex: string, alpha = 1): [number, number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
    alpha,
  ];
}

/** Attaches an alpha channel to a #RRGGBB color, as #RRGGBBAA. */
export function alphaColor(hex: string, alpha: number): string {
  const clamped = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hex}${clamped.toString(16).padStart(2, "0").toUpperCase()}`;
}

/**
 * Idle motion targets. The sphere is meant to feel heavy: the object itself
 * barely moves and the field carries the animation, slowly.
 */
export const ORB_MOTION = {
  /** Sphere breathing period, in milliseconds. */
  breathPeriodMs: 5200,
  /** A second, incommensurate period so the breath never visibly loops. */
  breathSecondaryMs: 8300,
  /** Peak sphere scale. Roughly 0.994 → 1.004. */
  breathAmplitude: 0.005,
  /** Bloom swell period, in milliseconds. */
  bloomPeriodMs: 6100,
  /** Time for the shell highlight to travel once around the sphere. */
  shellTraversalMs: 11000,
  /** Wavelength of the primary fiber, in points. */
  strandWavelengthPx: 322,
  /** Blend steps the fiber field interpolates between. */
  morphSteps: 3,
} as const;

export interface OrbAppearanceTuning {
  /** Multiplier on bloom alpha. Light mode needs restraint. */
  readonly bloomScale: number;
  /** Multiplier on shell brightness. Dark mode leans on the shell. */
  readonly shellScale: number;
  /** How much warmth bleeds into the dark core. */
  readonly coreWarmthScale: number;
  /** Multiplier on fiber alpha. */
  readonly fieldAlphaScale: number;
}

/**
 * Light and dark share geometry, not luminosity. On ivory the contrast is
 * already enormous so the bloom pulls back; on midnight a large bloom reads as
 * a gamer orb, so the shell does the work instead.
 */
export const ORB_APPEARANCE: Record<OrbAppearance, OrbAppearanceTuning> = {
  light: {
    bloomScale: 0.85,
    shellScale: 1,
    coreWarmthScale: 1,
    fieldAlphaScale: 0.9,
  },
  dark: {
    bloomScale: 0.5,
    shellScale: 1.15,
    coreWarmthScale: 1.1,
    fieldAlphaScale: 1.15,
  },
};

/**
 * Deterministic per-index pseudo-random in 0..1. Strands must never look
 * cloned, but they also must not re-randomize between renders.
 */
export function hash01(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return value - Math.floor(value);
}
