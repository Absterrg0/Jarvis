/**
 * Orb palette and tuning, derived from the reference renders.
 *
 * The defining property of this object is contrast: light lives almost
 * entirely at the boundary and the centre absorbs it. If the middle of the
 * sphere ever reads as bright copper, the render has failed regardless of how
 * good the rim looks.
 */
export const ORB_PALETTE = {
  /** Bright interior of the sphere. This is the light source of the object. */
  hot: "#FFF0DC",
  /** Body color away from the highlight. */
  copper: "#E8803F",
  /** Outer falloff, where the body turns to deep copper. */
  deep: "#4A1D0C",
  /** Crisp ring at the hull. */
  rim: "#FFF3E6",

  /** Strand colors. */
  warmCopper: "#E99676",
  peach: "#F6C9B8",
  hotRim: "#FFE1D2",

  /** Retained for the surface fallback and any dark-core treatment. */
  core: "#090605",
  coreWarm: "#1D0D08",
  ember: "#39170D",

  /** Surface colors the orb is composited against. */
  midnight: "#0B0B0C",
  ivory: "#FAF7F3",
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
 * Idle motion targets. The sphere is meant to feel extremely heavy: it barely
 * moves, and the field around it carries the animation.
 */
export const ORB_MOTION = {
  /** Sphere breathing period, in milliseconds. */
  breathPeriodMs: 3800,
  /** Second, incommensurate period so the breath never visibly loops. */
  breathSecondaryMs: 6100,
  /** Peak sphere scale. Ranges 0.992 → 1.006. */
  breathAmplitude: 0.007,
  /** Bloom swell period, in milliseconds. */
  bloomPeriodMs: 4200,
  /** Time for the rim highlight to travel once around the sphere. */
  rimTraversalMs: 9000,
  /** Maximum interior drift, as a fraction of radius. */
  driftFraction: 0.022,
  /** Wavelength of the primary fiber, in points. Motion wraps on this. */
  strandWavelengthPx: 322,
} as const;

export interface OrbAppearanceTuning {
  /** Multiplier on bloom alpha. Light mode needs restraint. */
  readonly bloomScale: number;
  /** Multiplier on rim brightness. Dark mode leans on the rim instead. */
  readonly rimScale: number;
  /** Multiplier on how luminous the sphere's interior is. */
  readonly warmthScale: number;
  /** Multiplier on how deep the copper falls off toward the hull. */
  readonly edgeDepthScale: number;
  /** Multiplier on fiber alpha. */
  readonly strandOpacity: number;
}

/**
 * Light and dark share geometry, not luminosity. On ivory the contrast is
 * already enormous so the bloom pulls back; on midnight the bloom would read
 * as a gamer orb, so the rim does the work instead.
 */
export const ORB_APPEARANCE: Record<OrbAppearance, OrbAppearanceTuning> = {
  light: {
    bloomScale: 0.8,
    rimScale: 1,
    warmthScale: 1,
    edgeDepthScale: 1,
    strandOpacity: 1,
  },
  dark: {
    bloomScale: 0.45,
    rimScale: 1.15,
    warmthScale: 0.92,
    edgeDepthScale: 1.18,
    strandOpacity: 1.3,
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
