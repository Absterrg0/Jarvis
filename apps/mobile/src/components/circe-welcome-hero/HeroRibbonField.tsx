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
 * the whole surface plus a highlight travelling along it. That is a deliberate
 * correction of an earlier revision which morphed the whole spline once per
 * loop. Geometric morphing both required a phase to wrap exactly, which it did
 * not, and turned a brand mark into an audio waveform.
 */

/** Filaments drawn with the brighter highlight treatment. */
const HERO_FILAMENT_INDICES: ReadonlySet<number> = new Set([3, 8, 14, 19]);

const STEPS_PER_SEGMENT = 26;

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
  readonly front: SkPath;
}

/**
 * The ribbon looks and behaves identically in every appearance; only its alpha
 * changes. Geometry therefore depends only on size, not on theme or time.
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

    // Interior geometry only needs to cover the sphere plus a margin, since it
    // is clipped to the sphere. Building it across the full hero width would
    // nearly triple the stroked segment count for no visible gain.
    const interiorSamples = samples.filter(
      (sample) => Math.abs(sample.x - centerX) <= radius * 1.2,
    );

    const minHalfWidth = radius * 0.16;
    const maxHalfWidth = radius * 0.74;
    const halfWidthAt = (x: number) =>
      bundleHalfWidth(x, centerX, radius, minHalfWidth, maxHalfWidth);

    const warp = (point: RibbonPoint) => lensWarp(point.x, point.y, centerX, centerY, radius, 0.4);

    const filaments = buildFilaments();
    return filaments.map((filament) => ({
      rear: pointsToPath(buildFilamentPoints(samples, filament.offset, halfWidthAt)),
      interior: pointsToPath(
        buildFilamentPoints(interiorSamples, filament.offset, halfWidthAt, warp),
      ),
      front: pointsToPath(buildFilamentPoints(samples, filament.offset, halfWidthAt)),
    }));
  }, [width, centerX, centerY, radius]);
}

function FilamentPath({
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
  // Inside the glass the strands have to read against a lit copper body rather
  // than against the page, and at the same copper they simply disappear into
  // it. They are therefore shifted hot and lifted, which is also physically
  // sensible: light coupling into the material is brighter, not dimmer.
  const interior = plane === "interior";
  const color = interior ? (filament.hero ? HERO_PALETTE.hot : HERO_PALETTE.peach) : filament.color;
  // Modest lift only: a large boost makes the ribbon look switched on inside the
  // sphere and dead outside it, instead of like one surface passing through.
  const baseAlpha = filament.alpha * scale * (interior ? 1.45 : 1);
  const glowColor = heroAlpha(color, baseAlpha * GLOW_ALPHA_RATIO);
  const coreColor = heroAlpha(color, baseAlpha);

  // The highlight is a symmetric gradient travelling along x, driven by moving
  // the gradient's endpoints rather than its stop positions: stop positions are
  // a plain array in this API, while start and end accept shared values. A
  // symmetric ramp also means there is no bright edge to pop when it wraps,
  // and because the travel is a slow out-and-back there is no wrap at all.
  const start = useDerivedValue(
    () => ({ x: highlightCenterX.value - highlightHalfWidth, y: 0 }),
    [highlightCenterX, highlightHalfWidth],
  );
  const end = useDerivedValue(
    () => ({ x: highlightCenterX.value + highlightHalfWidth, y: 0 }),
    [highlightCenterX, highlightHalfWidth],
  );
  const highlightAlpha = Math.min(1, baseAlpha * 1.9);
  const colors = useMemo(
    () => [
      coreColor,
      heroAlpha(filament.color, highlightAlpha),
      heroAlpha(HERO_PALETTE.hot, highlightAlpha * 0.85),
      heroAlpha(color, highlightAlpha),
      coreColor,
    ],
    [coreColor, color, highlightAlpha],
  );

  return (
    <Group>
      <Path
        path={path}
        style="stroke"
        strokeWidth={filament.width * GLOW_WIDTH_RATIO}
        strokeCap="round"
        strokeJoin="round"
        color={glowColor}
      />
      {filament.hero ? (
        <Path
          path={path}
          style="stroke"
          strokeWidth={filament.width}
          strokeCap="round"
          strokeJoin="round"
        >
          <LinearGradient
            start={start}
            end={end}
            colors={colors}
            positions={[0, 0.36, 0.5, 0.64, 1]}
          />
        </Path>
      ) : (
        <Path
          path={path}
          style="stroke"
          strokeWidth={filament.width}
          strokeCap="round"
          strokeJoin="round"
          color={coreColor}
        />
      )}
    </Group>
  );
}

/**
 * One depth plane of the woven surface.
 *
 * `rear` sits behind the body, `interior` is clipped and refracted through the
 * glass, and `front` carries only the hero filaments so the crossing reads as
 * light catching a couple of strands rather than as a second full field.
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

  // Front is a highlight pass, not a second field: only the first couple of
  // hero strands cross over the shell.
  let frontBudget = HERO_METRICS.frontRibbonCount;

  const paths = filaments.map((filament, index) => {
    if (plane === "front") {
      if (!filament.hero || frontBudget <= 0) return null;
      frontBudget -= 1;
    }
    const set = geometry[index];
    if (set === undefined) return null;
    return (
      <FilamentPath
        key={filament.index}
        path={set[plane]}
        filament={filament}
        plane={plane}
        scale={scale}
        highlightCenterX={highlightCenterX}
        highlightHalfWidth={highlightHalfWidth}
      />
    );
  });

  if (clip === undefined) return <Group>{paths}</Group>;
  return <Group clip={clip}>{paths}</Group>;
}
