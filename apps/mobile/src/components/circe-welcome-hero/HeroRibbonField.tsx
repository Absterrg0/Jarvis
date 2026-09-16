import { useMemo } from "react";
import { Group, LinearGradient, Path, Skia, type SkPath } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import {
  HERO_APPEARANCE,
  HERO_CENTRELINE,
  HERO_METRICS,
  HERO_PALETTE,
  heroAlpha,
  heroHash,
  type HeroAppearance,
} from "./heroTokens";
import {
  buildFilamentPoints,
  bundleHalfWidth,
  lensWarp,
  sampleCenterline,
  type RibbonPoint,
  type RibbonSample,
} from "./heroRibbonGeometry";

/**
 * The woven ribbon surface.
 *
 * One art-directed centreline carries every filament, offset along the curve's
 * own perpendicular so the strands stay locally parallel. Geometry is built
 * once and never re-interpolated: the only motion is a rigid vertical drift of
 * the whole surface plus a highlight travelling along it.
 *
 * Performance note, because this file has already been rewritten once for it:
 * the highlight gradient is the only animated property, and it lives in its own
 * component used only by the handful of hero strands. Attaching animated
 * derived values to all 72 filament instances cost about 55ms per frame, since
 * every one of them re-evaluated a worklet and allocated a point on every
 * frame. Ordinary strands are now hook-free and static.
 */

/** Filaments drawn with the brighter highlight treatment. */
const HERO_FILAMENT_INDICES: ReadonlySet<number> = new Set([3, 8, 14, 19]);

/**
 * Sampling density is a direct cost driver: stroke geometry is generated per
 * segment. The curve is smooth enough that this is visually identical to a
 * denser sampling.
 */
const STEPS_PER_SEGMENT = 14;

/** Glow is a narrow halo, not a smear. */
const GLOW_WIDTH_RATIO = 2.8;
const GLOW_ALPHA_RATIO = 0.16;

interface Filament {
  readonly index: number;
  /** Position across the bundle, -1..1. */
  readonly offset: number;
  readonly width: number;
  readonly alpha: number;
  readonly color: string;
  readonly hero: boolean;
}

function buildFilaments(): Filament[] {
  const count = HERO_METRICS.ribbonCount;
  const filaments: Filament[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = (index / (count - 1)) * 2 - 1;
    const hero = HERO_FILAMENT_INDICES.has(index);
    filaments.push({
      index,
      offset,
      // Ordinary strands are hairline; hero strands are just heavy enough to
      // catch the light without reading as a separate mark.
      width: hero ? 0.9 + heroHash(index, 42) * 0.25 : 0.55 + heroHash(index, 42) * 0.25,
      alpha: hero ? 0.52 + heroHash(index, 41) * 0.14 : 0.3 + (1 - Math.abs(offset)) * 0.22,
      color: hero
        ? HERO_PALETTE.ribbonPeach
        : index % 4 === 0
          ? HERO_PALETTE.ribbonAmber
          : HERO_PALETTE.ribbonCopper,
      hero,
    });
  }
  return filaments;
}

function pointsToPath(points: ReadonlyArray<RibbonPoint>): SkPath {
  const builder = Skia.PathBuilder.Make();
  points.forEach((point, index) => {
    if (index === 0) builder.moveTo(point.x, point.y);
    else builder.lineTo(point.x, point.y);
  });
  return builder.detach();
}

interface FilamentGeometry {
  readonly rear: SkPath;
  readonly interior: SkPath;
}

/**
 * Geometry depends only on size, never on theme or time.
 *
 * The interior copy is built across the sphere plus a margin rather than the
 * full hero width, since it is clipped to the sphere anyway.
 */
function useFilamentGeometry({
  width,
  centerX,
  centerY,
  radius,
}: {
  readonly width: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
}): ReadonlyArray<FilamentGeometry> {
  return useMemo(() => {
    const samples: RibbonSample[] = sampleCenterline(
      HERO_CENTRELINE,
      width,
      HERO_METRICS.height,
      STEPS_PER_SEGMENT,
    );
    const interiorSamples = samples.filter(
      (sample) => Math.abs(sample.x - centerX) <= radius * 1.2,
    );

    const minHalfWidth = radius * 0.16;
    const maxHalfWidth = radius * 0.74;
    const halfWidthAt = (x: number) =>
      bundleHalfWidth(x, centerX, radius, minHalfWidth, maxHalfWidth);
    const warp = (point: RibbonPoint) => lensWarp(point.x, point.y, centerX, centerY, radius, 0.4);

    return buildFilaments().map((filament) => ({
      rear: pointsToPath(buildFilamentPoints(samples, filament.offset, halfWidthAt)),
      interior: pointsToPath(
        buildFilamentPoints(interiorSamples, filament.offset, halfWidthAt, warp),
      ),
    }));
  }, [width, centerX, centerY, radius]);
}

/**
 * An ordinary strand. Deliberately hook-free: it draws the same paths on every
 * frame, so anything animated here would be paid for by all 24 strands.
 */
function StaticFilament({
  path,
  filament,
  plane,
  scale,
}: {
  readonly path: SkPath;
  readonly filament: Filament;
  readonly plane: "rear" | "interior" | "front";
  readonly scale: number;
}) {
  // Inside the glass the strands must read against a lit copper body rather than
  // against the page, and at the same copper they disappear into it entirely.
  const interior = plane === "interior";
  const color = interior ? HERO_PALETTE.peach : filament.color;
  const alpha = filament.alpha * scale * (interior ? 1.45 : 1);

  return (
    <Path
      path={path}
      style="stroke"
      strokeWidth={filament.width}
      strokeCap="round"
      color={heroAlpha(color, alpha)}
    />
  );
}

/**
 * A hero strand, carrying the travelling highlight.
 *
 * The highlight is a symmetric gradient whose endpoints slide along x. Stop
 * positions are a plain array in this API while the endpoints accept shared
 * values, and a symmetric ramp means there is no bright edge to pop when the
 * travel reverses.
 */
function HighlightFilament({
  path,
  filament,
  plane,
  scale,
  highlightCenterX,
  highlightHalfWidth,
}: {
  readonly path: SkPath;
  readonly filament: Filament;
  readonly plane: "rear" | "interior" | "front";
  readonly scale: number;
  readonly highlightCenterX: SharedValue<number>;
  readonly highlightHalfWidth: number;
}) {
  const interior = plane === "interior";
  const color = interior ? HERO_PALETTE.hot : filament.color;
  const alpha = filament.alpha * scale * (interior ? 1.45 : 1);

  const start = useDerivedValue(
    () => ({ x: highlightCenterX.value - highlightHalfWidth, y: 0 }),
    [highlightCenterX, highlightHalfWidth],
  );
  const end = useDerivedValue(
    () => ({ x: highlightCenterX.value + highlightHalfWidth, y: 0 }),
    [highlightCenterX, highlightHalfWidth],
  );

  const bright = Math.min(1, alpha * 1.9);
  const colors = useMemo(
    () => [
      heroAlpha(color, alpha),
      heroAlpha(color, bright),
      heroAlpha(HERO_PALETTE.hot, bright * 0.85),
      heroAlpha(color, bright),
      heroAlpha(color, alpha),
    ],
    [alpha, bright, color],
  );

  return (
    <Group>
      <Path
        path={path}
        style="stroke"
        strokeWidth={filament.width * GLOW_WIDTH_RATIO}
        strokeCap="round"
        color={heroAlpha(color, alpha * GLOW_ALPHA_RATIO)}
      />
      <Path path={path} style="stroke" strokeWidth={filament.width} strokeCap="round">
        <LinearGradient
          start={start}
          end={end}
          colors={colors}
          positions={[0, 0.36, 0.5, 0.64, 1]}
        />
      </Path>
    </Group>
  );
}

/**
 * One depth plane of the woven surface.
 *
 * `rear` sits behind the body, `interior` is clipped and refracted through the
 * glass, and `front` carries only the hero strands so the crossing reads as
 * light catching a couple of filaments rather than as a second full field.
 */
export function HeroRibbonField({
  plane,
  width,
  centerX,
  centerY,
  radius,
  clip,
  appearance,
  highlightCenterX,
}: {
  readonly plane: "rear" | "interior" | "front";
  readonly width: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly clip?: SkPath;
  readonly appearance: HeroAppearance;
  readonly highlightCenterX: SharedValue<number>;
}) {
  const geometry = useFilamentGeometry({ width, centerX, centerY, radius });
  const filaments = useMemo(() => buildFilaments(), []);
  const scale = HERO_APPEARANCE[appearance].ribbonScale;

  // The travelling highlight spans roughly a third of the hero.
  const highlightHalfWidth = Math.max(radius * 1.4, width * 0.16);

  let frontBudget = HERO_METRICS.frontRibbonCount;

  const paths = filaments.map((filament, index) => {
    if (plane === "front") {
      if (!filament.hero || frontBudget <= 0) return null;
      frontBudget -= 1;
    }
    const set = geometry[index];
    if (set === undefined) return null;
    const path = set[plane === "front" ? "rear" : plane];
    return filament.hero ? (
      <HighlightFilament
        key={filament.index}
        path={path}
        filament={filament}
        plane={plane}
        scale={scale}
        highlightCenterX={highlightCenterX}
        highlightHalfWidth={highlightHalfWidth}
      />
    ) : (
      <StaticFilament
        key={filament.index}
        path={path}
        filament={filament}
        plane={plane}
        scale={scale}
      />
    );
  });

  if (clip === undefined) return <Group>{paths}</Group>;
  return <Group clip={clip}>{paths}</Group>;
}
