/**
 * Tokens and geometry for the Circe welcome hero.
 *
 * This is a separate visual system from the in-app orb. The welcome hero is a
 * brand illustration: it is decorative, it has no voice states, and it is
 * allowed to be a large piece of artwork. The product orb stays a widget.
 */

export const HERO_PALETTE = {
  /** Deep centre of the body. Warm brown, never pitch black. */
  core: "#2A1710",
  /** Body volume. */
  warm: "#6E4534",
  /** Lit body. */
  copper: "#B9785B",
  /** Shell and rim. */
  peach: "#F2C9AC",
  /** Hot edge, specular and glints only. */
  hot: "#FFF2E5",

  /** Ribbon field. */
  ribbonCopper: "#C9784F",
  ribbonAmber: "#E29A68",
  ribbonPeach: "#F2C0A0",

  paper: "#FCF9F4",
} as const;

export type HeroAppearance = "light" | "dark";

interface HeroAppearanceTuning {
  /** Multiplier on the atmosphere alpha. */
  readonly glowScale: number;
  /** Multiplier on ribbon alpha. */
  readonly ribbonScale: number;
}

/**
 * Light and dark share the geometry and differ only in luminosity. On ivory the
 * atmosphere must stay restrained or the page looks dirty; on a dark surface it
 * needs a little more to avoid disappearing.
 */
export const HERO_APPEARANCE: Record<HeroAppearance, HeroAppearanceTuning> = {
  light: { glowScale: 1, ribbonScale: 1 },
  dark: { glowScale: 0.62, ribbonScale: 1.15 },
};

/** Hero geometry, expressed relative to the hero's available width. */
export const HERO_METRICS = {
  /** Fixed hero height. Wide and short, like a banner illustration. */
  height: 300,
  /** Orb radius as a fraction of hero width, clamped. */
  radiusFraction: 0.215,
  radiusMin: 76,
  radiusMax: 88,
  /**
   * Orb centre as a fraction of hero height. Sits in the upper-middle zone but
   * leaves enough room above that the widest halo arc is not cut off.
   */
  centerYFraction: 0.46,
  /** Ribbon filaments across the woven surface. */
  ribbonCount: 24,
  /** Filaments that cross in front of the shell. */
  frontRibbonCount: 2,
  /** Halo arcs behind the orb. */
  arcCount: 4,
  /** External dust motes. Deliberately few. */
  particleCount: 7,
  /** Internal light motes inside the body. */
  internalMoteCount: 20,
} as const;

/**
 * The master centreline, in hero-normalized coordinates (x across the width,
 * y across the height). This is deliberately art-directed rather than
 * generated: it is one shallow S that passes through the sphere, so the ribbon
 * reads as a single surface threaded through the object.
 *
 * These points do not animate. See `HERO_MOTION`.
 */
export const HERO_CENTRELINE: ReadonlyArray<readonly [number, number]> = [
  [-0.12, 0.6],
  [0.1, 0.5],
  [0.3, 0.44],
  [0.5, 0.46],
  [0.68, 0.53],
  [0.86, 0.56],
  [1.12, 0.44],
];

/**
 * Motion budget.
 *
 * The primary spline geometry is frozen. The ribbon is a brand mark, not an
 * audio waveform, so the silhouette has to stay essentially stable: the whole
 * surface drifts rigidly by a few dp, and the life in the illustration comes
 * from a highlight travelling along it and from slow atmosphere breathing.
 *
 * A rigid translate cannot introduce a loop seam, which is why there is no
 * geometry morphing and therefore no phase-wrap discontinuity anywhere.
 */
export const HERO_MOTION = {
  /** Rigid vertical drift of the entire ribbon surface, in dp. */
  ribbonDriftDp: 4,
  /** Seconds for one full out-and-back drift. */
  ribbonDriftSeconds: 12,
  /** Seconds for the highlight to travel from one end to the other and back. */
  highlightPeriodSeconds: 15,
  /** Seconds for the atmosphere and halo arcs to complete one breath. */
  breathSeconds: 13,
} as const;

/** Attaches an alpha channel to a #RRGGBB color, as #RRGGBBAA. */
export function heroAlpha(hex: string, alpha: number): string {
  "worklet";
  const clamped = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hex}${clamped.toString(16).padStart(2, "0").toUpperCase()}`;
}

/** Deterministic per-index pseudo-random in 0..1. */
export function heroHash(index: number, salt: number): number {
  const value = Math.sin(index * 91.7 + salt * 233.1) * 43758.5453;
  return value - Math.floor(value);
}
