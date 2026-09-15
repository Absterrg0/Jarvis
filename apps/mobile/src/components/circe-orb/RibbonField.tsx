import { useMemo } from "react";
import { Group, Path, Skia, usePathInterpolation, type SkPath } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import {
  ORB_APPEARANCE,
  ORB_PALETTE,
  ORB_MOTION,
  alphaColor,
  hash01,
  type OrbAppearance,
} from "./orbTokens";
import type { OrbStateParams } from "./orbState";

/**
 * The Circe ribbon.
 *
 * An earlier version gave every strand its own frequency, amplitude, phase,
 * offset and speed. That is a recipe for spaghetti no matter how many strands
 * are removed, and it is why the field read as procedural noise.
 *
 * There is now exactly ONE flowing centerline. Every ribbon filament is a small
 * offset from it, so the group reads as a single piece of silk. A few very faint
 * atmosphere fibers keep their own trajectories, but they are deliberately
 * barely visible.
 *
 * Ribbon filaments: 8, alpha 0.14-0.34, two of them highlighted at 0.38-0.55.
 * Atmosphere fibers: 5, alpha 0.04-0.10.
 */

interface Filament {
  readonly index: number;
  /** Position across the ribbon, -1..1. */
  readonly offset: number;
  readonly alpha: number;
  readonly width: number;
  readonly color: string;
  readonly jitterPhase: number;
  readonly jitterAmount: number;
  /** Independent trajectory, used only by the faint atmosphere fibers. */
  readonly independent: boolean;
  readonly frequency: number;
  readonly phase: number;
  readonly amplitude: number;
  readonly yOffset: number;
}

const OVERSCAN = 140;
const SEGMENTS = 128;
const MORPH_STEPS = ORB_MOTION.morphSteps;

/** Primary wavelength of the shared centerline, in points. */
const CENTERLINE_K = (Math.PI * 2) / ORB_MOTION.strandWavelengthPx;

const RIBBON_COUNT = 8;
const ATMOSPHERE_COUNT = 5;

function buildFilaments(radius: number): Filament[] {
  const filaments: Filament[] = [];

  // The ribbon. Offsets are spread across the bundle width and alpha rises
  // toward the interior so the fabric has a bright core and soft edges.
  for (let index = 0; index < RIBBON_COUNT; index += 1) {
    const offset = (index / (RIBBON_COUNT - 1)) * 2 - 1;
    const centrality = 1 - Math.abs(offset);
    const hero = index === 2 || index === 5;
    filaments.push({
      index,
      offset,
      alpha: hero ? 0.38 + hash01(index, 21) * 0.17 : 0.14 + centrality * 0.2,
      width: hero ? 1.15 + hash01(index, 22) * 0.3 : 0.7 + hash01(index, 22) * 0.25,
      color: hero ? ORB_PALETTE.peach : ORB_PALETTE.copper,
      jitterPhase: hash01(index, 23) * Math.PI * 2,
      jitterAmount: 0.6 + hash01(index, 24) * 1.2,
      independent: false,
      frequency: CENTERLINE_K,
      phase: 0,
      amplitude: 1,
      yOffset: 0,
    });
  }

  // Atmosphere fibers. Faint, independent, and never the focus.
  for (let index = 0; index < ATMOSPHERE_COUNT; index += 1) {
    filaments.push({
      index: RIBBON_COUNT + index,
      offset: 0,
      alpha: 0.04 + hash01(index, 31) * 0.06,
      width: 0.6 + hash01(index, 32) * 0.25,
      color: ORB_PALETTE.copper,
      jitterPhase: 0,
      jitterAmount: 0,
      independent: true,
      frequency: CENTERLINE_K * (0.55 + hash01(index, 33) * 0.5),
      phase: hash01(index, 34) * Math.PI * 2,
      amplitude: (10 + hash01(index, 35) * 12) * 0.5,
      yOffset: (hash01(index, 36) - 0.5) * 2 * radius * 0.95,
    });
  }

  return filaments;
}

export type RibbonPlane = "rear" | "interior" | "front";

/**
 * The shared centerline: one broad S-curve that every ribbon filament follows.
 *
 * Both harmonics carry an integer coefficient on the phase, so the curve
 * returns to exactly its starting shape after a full phase revolution and the
 * interpolation between keyframes is seamless.
 */
function centerlineY(
  x: number,
  centerX: number,
  centerY: number,
  radius: number,
  phase: number,
  amplitudeScale: number,
): number {
  const envelope = 0.28 + 0.72 * Math.exp(-Math.pow((x - centerX) / (radius * 1.35), 2));
  return (
    centerY +
    (Math.sin(CENTERLINE_K * x + phase) * 17 + Math.sin(CENTERLINE_K * 0.5 * x - phase) * 8) *
      envelope *
      amplitudeScale
  );
}

/** How wide the bundle is at a given x. Widens near the sphere, narrows out. */
function bundleEnvelope(x: number, centerX: number, radius: number): number {
  return 0.3 + 0.7 * Math.exp(-Math.pow((x - centerX) / (radius * 1.1), 2));
}

function buildFilamentPath(
  filament: Filament,
  phase: number,
  width: number,
  centerX: number,
  centerY: number,
  radius: number,
  plane: RibbonPlane,
  amplitudeScale: number,
): SkPath {
  const path = Skia.PathBuilder.Make();
  const span = width + OVERSCAN * 2;
  const bundleHalfWidth = radius * 0.3;
  const refraction = plane === "interior";

  for (let s = 0; s <= SEGMENTS; s += 1) {
    const t = s / SEGMENTS;
    const x = t * span - OVERSCAN;
    const nx = Math.max(-1, Math.min(1, (x - centerX) / radius));
    const z = Math.sqrt(Math.max(0, 1 - nx * nx));

    let outY: number;

    if (filament.independent) {
      outY =
        centerY +
        filament.yOffset +
        Math.sin(filament.frequency * x + phase + filament.phase) * filament.amplitude;
    } else {
      // Inside the lens the centerline's phase is delayed by depth and its
      // amplitude grows, so the ribbon visibly bends as it enters the sphere.
      const lensPhase = refraction ? phase + z * 1.1 : phase;
      const lensAmplitude = amplitudeScale * (refraction ? 1 + z * 0.45 : 1);
      const base = centerlineY(x, centerX, centerY, radius, lensPhase, lensAmplitude);
      const jitter =
        Math.sin(x * 0.021 + phase * 0.5 + filament.jitterPhase) * filament.jitterAmount;
      outY = base + filament.offset * bundleHalfWidth * bundleEnvelope(x, centerX, radius) + jitter;

      if (refraction) {
        // Lens pinch: the bundle compresses toward the optical axis, hardest
        // at the centre of the sphere where the glass is thickest.
        outY = centerY + (outY - centerY) * (1 - 0.42 * z);
      }
    }

    if (s === 0) path.moveTo(x, outY);
    else path.lineTo(x, outY);
  }
  return path.detach();
}

function Filament({
  filament,
  width,
  centerX,
  centerY,
  radius,
  plane,
  fieldPhase,
  energySV,
  params,
  appearance,
}: {
  readonly filament: Filament;
  readonly width: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly plane: RibbonPlane;
  readonly fieldPhase: SharedValue<number>;
  readonly energySV: SharedValue<number>;
  readonly params: OrbStateParams;
  readonly appearance: OrbAppearance;
}) {
  // The state's field amplitude feeds the path itself, not just a scale applied
  // afterwards. Without this the parameter existed but changed nothing.
  const amplitudeScale = params.fieldAmplitude;

  const frames = useMemo(() => {
    const step = (Math.PI * 2) / MORPH_STEPS;
    return Array.from({ length: MORPH_STEPS + 1 }, (_, index) =>
      buildFilamentPath(
        filament,
        index * step,
        width,
        centerX,
        centerY,
        radius,
        plane,
        amplitudeScale,
      ),
    );
  }, [filament, width, centerX, centerY, radius, plane, amplitudeScale]);

  const localPhase = useDerivedValue(() => fieldPhase.value, [fieldPhase]);
  const morphed = usePathInterpolation(
    localPhase,
    Array.from({ length: MORPH_STEPS + 1 }, (_, index) => index),
    frames,
  );

  // Microphone energy widens the ribbon vertically and lifts its brightness.
  const stretch = useDerivedValue(
    () => [{ scaleY: 1 + energySV.value * 0.45 * params.energyResponse }],
    [energySV, params.energyResponse],
  );
  const liveAlpha = useDerivedValue(
    () =>
      filament.alpha *
      params.fieldAlpha *
      ORB_APPEARANCE[appearance].fieldAlphaScale *
      (1 + energySV.value * 0.35 * params.energyResponse),
    [appearance, energySV, filament.alpha, params.energyResponse, params.fieldAlpha],
  );

  const restY = centerY + filament.yOffset;
  const glowColor = useDerivedValue(
    () => alphaColor(filament.color, liveAlpha.value * 0.1),
    [filament.color, liveAlpha],
  );
  const coreColor = useDerivedValue(
    () => alphaColor(filament.color, liveAlpha.value),
    [filament.color, liveAlpha],
  );

  return (
    <Group origin={{ x: centerX, y: restY }} transform={stretch}>
      <Path
        path={morphed}
        style="stroke"
        strokeWidth={filament.width * 5}
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
 * One plane of the ribbon field.
 *
 * `rear` renders behind the sphere, `interior` is refracted and must be drawn
 * between the base and volume passes, and `front` crosses over the whole
 * composition. The same ribbon in three planes is what produces depth; none of
 * this is a real 3D render.
 */
export function OrbRibbonPlane({
  plane,
  width,
  centerX,
  centerY,
  radius,
  clip,
  fieldPhase,
  energySV,
  params,
  appearance,
}: {
  readonly plane: RibbonPlane;
  readonly width: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly clip?: SkPath;
  readonly fieldPhase: SharedValue<number>;
  readonly energySV: SharedValue<number>;
  readonly params: OrbStateParams;
  readonly appearance: OrbAppearance;
}) {
  const filaments = useMemo(() => buildFilaments(radius), [radius]);

  // The front plane carries only the two highlighted filaments, so the ribbon
  // reads as crossing in front rather than as a second full field.
  const visible =
    plane === "front"
      ? filaments.filter((f) => !f.independent && (f.index === 2 || f.index === 5))
      : filaments;

  const strands = visible.map((filament) => (
    <Filament
      key={filament.index}
      filament={filament}
      width={width}
      centerX={centerX}
      centerY={centerY}
      radius={radius}
      plane={plane}
      fieldPhase={fieldPhase}
      energySV={energySV}
      params={params}
      appearance={appearance}
    />
  ));

  if (clip === undefined) return <Group>{strands}</Group>;
  return <Group clip={clip}>{strands}</Group>;
}
