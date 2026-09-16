/**
 * Tokens for the Circe welcome hero.
 *
 * This is a separate visual system from the in-app orb. The welcome hero is a
 * brand illustration: it is decorative, it has no voice states, and it is
 * allowed to be a large piece of artwork. The product orb stays a widget.
 *
 * The palette is deliberately more luminous than the product orb's. An earlier
 * revision reused the dark absorptive product sphere here and the hero read as
 * a black ball on a blank page, which is the opposite of the intent.
 */
export const HERO_PALETTE = {
  /** Deep centre. Warm brown, never pitch black. */
  core: "#3B241B",
  /** Body volume. */
  warm: "#6E4534",
  /** Lit body. */
  copper: "#B9785B",
  /** Shell. */
  peach: "#F2C9AC",
  /** Hot edge and flares only. */
  hot: "#FFF2E5",

  /** Ribbon field. */
  ribbonCopper: "#C9784F",
  ribbonAmber: "#E29A68",
  ribbonPeach: "#F2C0A0",

  /** Page surfaces. */
  paper: "#FCF9F4",
} as const;

export type HeroAppearance = "light" | "dark";

interface HeroAppearanceTuning {
  /** Multiplier on the atmosphere and glow alphas. */
  readonly glowScale: number;
  /** Multiplier on ribbon alpha. */
  readonly ribbonScale: number;
  /** Where the body gradient ends and the hot edge begins. */
  readonly edgeStart: number;
}

/**
 * Light and dark share the geometry and differ only in luminosity. On ivory the
 * atmosphere must stay restrained or the page looks dirty; on a dark surface it
 * needs a little more to avoid disappearing.
 */
export const HERO_APPEARANCE: Record<HeroAppearance, HeroAppearanceTuning> = {
  light: { glowScale: 1, ribbonScale: 1, edgeStart: 0.94 },
  dark: { glowScale: 0.62, ribbonScale: 1.18, edgeStart: 0.93 },
};

/** Hero geometry, expressed relative to the hero's available width. */
export const HERO_METRICS = {
  /** Fixed hero height. Wide and short, like a banner illustration. */
  height: 300,
  /** Orb radius as a fraction of hero width, clamped. */
  radiusFraction: 0.27,
  radiusMin: 84,
  radiusMax: 100,
  /**
   * Orb centre as a fraction of hero height. Sits in the upper-middle zone but
   * leaves enough room above that the widest halo arc is not cut off.
   */
  centerYFraction: 0.46,
  /** Ribbon filaments per side of the fan. */
  ribbonCount: 14,
  /** Filaments that cross in front of the orb. */
  frontRibbonCount: 2,
  /** Halo arcs behind the orb. */
  arcCount: 4,
  /** Dust motes. Deliberately few. */
  particleCount: 7,
} as const;

/** One full ribbon drift cycle, in seconds. Slow on purpose. */
export const HERO_RIBBON_CYCLE_SECONDS = 14;

/** Attaches an alpha channel to a #RRGGBB color, as #RRGGBBAA. */
export function heroAlpha(hex: string, alpha: number): string {
  "worklet";
  const clamped = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hex}${clamped.toString(16).padStart(2, "0").toUpperCase()}`;
}

/** Hex (#RRGGBB) to a normalized rgba tuple for shader uniforms. */
export function heroRgba(hex: string, alpha = 1): [number, number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
    alpha,
  ];
}

/** Deterministic per-index pseudo-random in 0..1. */
export function heroHash(index: number, salt: number): number {
  const value = Math.sin(index * 91.7 + salt * 233.1) * 43758.5453;
  return value - Math.floor(value);
}
