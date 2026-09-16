import { useMemo } from "react";
import { Group, Path, Skia, usePathInterpolation, type SkPath } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import {
  HERO_APPEARANCE,
  HERO_METRICS,
  HERO_PALETTE,
  HERO_RIBBON_CYCLE_SECONDS,
  heroAlpha,
  heroHash,
  type HeroAppearance,
} from "./heroTokens";

/**
 * The ribbon fan.
 *
 * Not independent sine waves. There is ONE master spline across the hero, and
 * every filament is an offset from that single curve, so the group reads as one
 * piece of silk rather than as spaghetti. The bundle is tight where it passes
 * the orb and fans out toward both edges, which is what creates the left and
 * right fans from a single construction.
 *
 * Rendered in three planes: behind the orb, refracted through it, and one or
 * two filaments crossing in front. That is what sells the depth.
 */

const OVERSCAN = 80;
const SEGMENTS = 160;
const MORPH_STEPS = 3;

interface Filament {
  readonly index: number;
  /** Position across the bundle, -1..1. */
  readonly offset: number;
  readonly alpha: number;
  readonly width: number;
  readonly color: string;
  readonly jitterPhase: number;
  readonly jitterAmount: number;
  readonly hero: boolean;
}

function buildFilaments(): Filament[] {
  const count = HERO_METRICS.ribbonCount;
  const filaments: Filament[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = (index / (count - 1)) * 2 - 1;
    // Brightest at the centre of the bundle, softening toward its edges.
    const centrality = 1 - Math.abs(offset);
    const hero = index === 4 || index === 7 || index === 11;
    filaments.push({
      index,
      offset,
      alpha: hero ? 0.46 + heroHash(index, 41) * 0.16 : 0.16 + centrality * 0.17,
      width: hero ? 1.6 + heroHash(index, 42) * 0.4 : 1 + heroHash(index, 42) * 0.4,
      color: hero
        ? HERO_PALETTE.ribbonPeach
        : index % 3 === 0
          ? HERO_PALETTE.ribbonAmber
          : HERO_PALETTE.ribbonCopper,
      jitterPhase: heroHash(index, 43) * Math.PI * 2,
      jitterAmount: 0.8 + heroHash(index, 44) * 1.6,
      hero,
    });
  }
  return filaments;
}

/**
 * The single master spline.
 *
 * Both harmonics carry an integer coefficient on the phase, so the curve
 * returns to its exact starting shape after one phase revolution and the
 * keyframe interpolation stays seamless.
 */
function masterCurve(x: number, centerX: number, centerY: number, phase: number): number {
  const t = (x - centerX) / 260;
  return (
    centerY +
    Math.sin(t * 1.35 + phase) * 22 +
    Math.sin(t * 0.62 - phase) * 12 +
    Math.sin(t * 2.4 + phase * 0.5) * 4
  );
}

/**
 * Bundle half-width. Tight at the orb, wide at the edges, which is what turns
 * one curve into a fan that converges visually on the object.
 */
function bundleHalfWidth(x: number, centerX: number, radius: number): number {
  // Tight at the orb, wide at the edges. The divisor sets how quickly the fan
  // opens; the earlier value opened too slowly, so the strands stayed bunched
  // and read as one flat smudge rather than a fan.
  // Dense near the orb, looser at the edges, but never a bowtie. An earlier
  // value opened from 8% to 123% of the radius within half a screen, which read
  // as a starburst rather than a ribbon.
  const t = Math.min(1, Math.abs(x - centerX) / (radius * 2.8));
  return radius * (0.32 + 0.5 * t);
}

function buildFilamentPath(
  filament: Filament,
  phase: number,
  width: number,
  centerX: number,
  centerY: number,
  radius: number,
  plane: "rear" | "interior" | "front",
): SkPath {
  const path = Skia.PathBuilder.Make();
  const span = width + OVERSCAN * 2;
  const refracting = plane === "interior";

  for (let s = 0; s <= SEGMENTS; s += 1) {
    const t = s / SEGMENTS;
    const x = t * span - OVERSCAN;
    const nx = Math.max(-1, Math.min(1, (x - centerX) / radius));
    const z = Math.sqrt(Math.max(0, 1 - nx * nx));

    // Inside the glass the shared curve is delayed and amplified, so the whole
    // bundle bends rather than merely being clipped.
    const lensPhase = refracting ? phase + z * 1.15 : phase;
    const lensScale = refracting ? 1 + z * 0.4 : 1;
    const base = centerY + (masterCurve(x, centerX, centerY, lensPhase) - centerY) * lensScale;

    const jitter = Math.sin(x * 0.013 + phase * 0.5 + filament.jitterPhase) * filament.jitterAmount;
    let y = base + filament.offset * bundleHalfWidth(x, centerX, radius) + jitter;

    if (refracting) {
      // Lens pinch toward the optical axis, strongest through the middle, so
      // the fan visibly narrows as it passes through the glass.
      y = centerY + (y - centerY) * (1 - 0.4 * z);
    }

    if (s === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  return path.detach();
}

function FilamentPath({
  filament,
  width,
  centerX,
  centerY,
  radius,
  plane,
  ribbonPhase,
  appearance,
  reducedMotion,
}: {
  readonly filament: Filament;
  readonly width: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly plane: "rear" | "interior" | "front";
  readonly ribbonPhase: SharedValue<number>;
  readonly appearance: HeroAppearance;
  readonly reducedMotion: boolean;
}) {
  const frames = useMemo(() => {
    const step = (Math.PI * 2) / MORPH_STEPS;
    return Array.from({ length: MORPH_STEPS + 1 }, (_, index) =>
      buildFilamentPath(filament, index * step, width, centerX, centerY, radius, plane),
    );
  }, [filament, width, centerX, centerY, radius, plane]);

  const localPhase = useDerivedValue(() => ribbonPhase.value, [ribbonPhase]);
  const morphed = usePathInterpolation(
    localPhase,
    Array.from({ length: MORPH_STEPS + 1 }, (_, index) => index),
    frames,
  );

  const scale = HERO_APPEARANCE[appearance].ribbonScale;
  // Interior strands are brighter so the crossing reads as light coupling into
  // the object rather than as lines passing behind it.
  const planeBoost = plane === "interior" ? 1.5 : 1;

  const glowColor = useDerivedValue(
    () => heroAlpha(filament.color, filament.alpha * scale * planeBoost * 0.12),
    [appearance, filament.alpha, filament.color, planeBoost, scale],
  );
  const coreColor = useDerivedValue(
    () => heroAlpha(filament.color, filament.alpha * scale * planeBoost),
    [appearance, filament.alpha, filament.color, planeBoost, scale],
  );
  const stretch = useDerivedValue(() => [{ scaleY: reducedMotion ? 1 : 1 }], [reducedMotion]);

  return (
    <Group origin={{ x: centerX, y: centerY }} transform={stretch}>
      <Path
        path={morphed}
        style="stroke"
        strokeWidth={filament.width * 6}
        strokeCap="round"
        color={glowColor}
      />
      <Path
        path={morphed}
        style="stroke"
        strokeWidth={filament.width}
        strokeCap="round"
        color={coreColor}
      />
    </Group>
  );
}

/**
 * One plane of the ribbon fan.
 *
 * `rear` sits behind the orb, `interior` is clipped and refracted through it,
 * and `front` carries only the hero filaments so the crossing reads as one or
 * two strands rather than a second full field.
 */
export function HeroRibbonField({
  plane,
  width,
  centerX,
  centerY,
  radius,
  clip,
  ribbonPhase,
  appearance,
  reducedMotion,
}: {
  readonly plane: "rear" | "interior" | "front";
  readonly width: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly clip?: SkPath;
  readonly ribbonPhase: SharedValue<number>;
  readonly appearance: HeroAppearance;
  readonly reducedMotion: boolean;
}) {
  const filaments = useMemo(() => buildFilaments(), []);
  const visible = useMemo(() => {
    if (plane !== "front") return filaments;
    return filaments.filter((f) => f.hero).slice(0, HERO_METRICS.frontRibbonCount);
  }, [filaments, plane]);

  const paths = visible.map((filament) => (
    <FilamentPath
      key={filament.index}
      filament={filament}
      width={width}
      centerX={centerX}
      centerY={centerY}
      radius={radius}
      plane={plane}
      ribbonPhase={ribbonPhase}
      appearance={appearance}
      reducedMotion={reducedMotion}
    />
  ));

  if (clip === undefined) return <Group>{paths}</Group>;
  return <Group clip={clip}>{paths}</Group>;
}
