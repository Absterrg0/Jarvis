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
 * A single silk filament.
 *
 * These are filaments, not an audio waveform and not an equalizer. Most of them
 * should be barely there: you should be able to squint at the screen and
 * perceive a flowing field rather than count individual lines. Two hero strands
 * carry the eye; everything else is texture.
 */
interface StrandSpec {
  readonly index: number;
  readonly hero: boolean;
  readonly frequency: number;
  readonly amplitude: number;
  readonly phase: number;
  readonly yOffset: number;
  readonly width: number;
  readonly alpha: number;
  readonly color: string;
  readonly speedScale: number;
}

const OVERSCAN = 140;
const SEGMENTS = 120;

export type StrandPlane = "rear" | "interior" | "front";

/**
 * Strand budgets. Deliberately small, and heaviest on the plane behind the
 * sphere where lines are cheapest to read as depth.
 */
const PLANE: Record<
  StrandPlane,
  {
    readonly count: number;
    readonly spread: number;
    readonly amplitude: number;
    readonly alphaMin: number;
    readonly alphaMax: number;
    readonly widthMin: number;
    readonly widthMax: number;
  }
> = {
  rear: {
    count: 11,
    spread: 0.86,
    amplitude: 1.0,
    alphaMin: 0.05,
    alphaMax: 0.13,
    widthMin: 0.6,
    widthMax: 0.9,
  },
  interior: {
    count: 7,
    spread: 0.24,
    amplitude: 1.5,
    alphaMin: 0.12,
    alphaMax: 0.33,
    widthMin: 0.6,
    widthMax: 0.95,
  },
  front: {
    count: 2,
    spread: 0.3,
    amplitude: 1.1,
    alphaMin: 0.18,
    alphaMax: 0.36,
    widthMin: 0.7,
    widthMax: 1.0,
  },
};

function buildSpecs(plane: StrandPlane, radius: number): StrandSpec[] {
  const shape = PLANE[plane];
  // One hero strand per plane. A single line the eye can follow reads as
  // intentional where twenty equal lines read as noise.
  const heroIndex = plane === "front" ? 1 : 0;
  const specs: StrandSpec[] = [];
  for (let index = 0; index < shape.count; index += 1) {
    const hero = index === heroIndex;
    const alpha = shape.alphaMin + hash01(index, 6) * (shape.alphaMax - shape.alphaMin);
    specs.push({
      index,
      hero,
      frequency: 0.0031 * (1 + (hash01(index, 1) - 0.5) * 0.32),
      amplitude: (7 + hash01(index, 2) * 9) * shape.amplitude * (hero ? 1.15 : 1),
      phase: hash01(index, 3) * Math.PI * 2,
      yOffset: (hash01(index, 4) - 0.5) * 2 * radius * shape.spread,
      width: shape.widthMin + hash01(index, 5) * (shape.widthMax - shape.widthMin),
      alpha: hero ? alpha * 1.7 : alpha,
      // Only heroes get peach. Everything else stays on copper, which keeps
      // the field quiet without making it disappear.
      color: hero ? ORB_PALETTE.peach : ORB_PALETTE.copper,
      speedScale: 0.55 + hash01(index, 7) * 0.9,
    });
  }
  return specs;
}

/**
 * Builds one filament at a given phase.
 *
 * The vertical envelope is a gaussian centred on the sphere, so activity grows
 * near Circe and settles toward the screen edges. The secondary harmonic is
 * exactly double the primary frequency, which lets the strand wrap seamlessly
 * once its phase advances a full period.
 *
 * Interior strands are refracted rather than merely squeezed. Treating the
 * sphere as a lens, the horizontal position gives a depth `z`; that depth
 * controls both how far the strand is pulled toward the optical axis and how
 * much its phase is shifted. Near the hull the strand is barely displaced, and
 * through the middle it bends, which is what sells the fiber as living inside
 * the glass.
 */
function buildStrandPath(
  spec: StrandSpec,
  phase: number,
  width: number,
  centerX: number,
  centerY: number,
  radius: number,
  plane: StrandPlane,
): SkPath {
  const path = Skia.PathBuilder.Make();
  const span = width + OVERSCAN * 2;
  const k = spec.frequency * Math.PI * 2;
  const envelopeWidth = radius * 1.35;
  const restY = centerY + spec.yOffset;

  for (let s = 0; s <= SEGMENTS; s += 1) {
    const t = s / SEGMENTS;
    const x = t * span - OVERSCAN;
    const envelope = 0.35 + 0.65 * Math.exp(-Math.pow((x - centerX) / envelopeWidth, 2));

    let outX = x;
    let outY = restY;

    if (plane === "interior") {
      const nx = Math.max(-1, Math.min(1, (x - centerX) / radius));
      const z = Math.sqrt(Math.max(0, 1 - nx * nx));
      // Depth-shifted phase: the strand's own motion is delayed through the
      // middle of the lens, so it visibly bends rather than just narrowing.
      const lensPhase = phase + z * 1.6;
      const wave = Math.sin(k * x + lensPhase) + 0.32 * Math.sin(2 * k * x - lensPhase * 0.7);
      outY = centerY + (restY - centerY + spec.amplitude * wave * envelope) * (1 - 0.34 * z);
    } else {
      const wave = Math.sin(k * x + phase) + 0.32 * Math.sin(2 * k * x - phase * 0.7);
      outY = restY + spec.amplitude * wave * envelope;
    }

    if (s === 0) path.moveTo(outX, outY);
    else path.lineTo(outX, outY);
  }
  return path.detach();
}

function Strand({
  spec,
  width,
  centerX,
  centerY,
  radius,
  plane,
  fieldPhase,
  energySV,
  params,
  appearance,
  morphSteps,
}: {
  readonly spec: StrandSpec;
  readonly width: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly plane: StrandPlane;
  readonly fieldPhase: SharedValue<number>;
  readonly energySV: SharedValue<number>;
  readonly params: OrbStateParams;
  readonly appearance: OrbAppearance;
  readonly morphSteps: number;
}) {
  const frames = useMemo(() => {
    const step = (Math.PI * 2) / morphSteps;
    return Array.from({ length: morphSteps + 1 }, (_, index) =>
      buildStrandPath(spec, spec.phase + index * step, width, centerX, centerY, radius, plane),
    );
  }, [spec, width, centerX, centerY, radius, plane, morphSteps]);

  const localPhase = useDerivedValue(
    () => (fieldPhase.value * spec.speedScale + spec.phase) % morphSteps,
    [fieldPhase, spec.speedScale, spec.phase, morphSteps],
  );
  const morphed = usePathInterpolation(
    localPhase,
    Array.from({ length: morphSteps + 1 }, (_, index) => index),
    frames,
  );

  // Only the field amplitude responds to energy; the object itself stays still.
  const stretch = useDerivedValue(() => [
    {
      scaleY: 1 + energySV.value * 0.45 * params.energyResponse * (spec.hero ? 1.25 : 1),
    },
  ]);

  const alpha = spec.alpha * params.fieldAlpha * ORB_APPEARANCE[appearance].fieldAlphaScale;
  const restY = centerY + spec.yOffset;

  return (
    <Group origin={{ x: centerX, y: restY }} transform={stretch}>
      {/* Wide, very faint pass stands in for a glow. A real BlurMask allocates
          a layer, which renders as a translucent rectangle on some GPUs. */}
      <Path
        path={morphed}
        style="stroke"
        strokeWidth={spec.width * 5}
        strokeCap="round"
        color={alphaColor(spec.color, alpha * 0.1)}
      />
      <Path
        path={morphed}
        style="stroke"
        strokeWidth={spec.width}
        strokeCap="round"
        color={alphaColor(spec.color, alpha)}
      />
    </Group>
  );
}

/**
 * One plane of the fiber field.
 *
 * `rear` renders behind the sphere, `interior` is refracted and must be drawn
 * between the sphere's base and shell passes, and `front` crosses over it.
 * Rendering the same field in three planes is what produces depth; none of
 * this is a real 3D render.
 */
export function OrbStrandPlane({
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
  readonly plane: StrandPlane;
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
  const specs = useMemo(() => buildSpecs(plane, radius), [plane, radius]);
  const strands = specs.map((spec) => (
    <Strand
      key={spec.index}
      spec={spec}
      width={width}
      centerX={centerX}
      centerY={centerY}
      radius={radius}
      plane={plane}
      fieldPhase={fieldPhase}
      energySV={energySV}
      params={params}
      appearance={appearance}
      morphSteps={ORB_MOTION.morphSteps}
    />
  ));

  if (clip === undefined) return <Group>{strands}</Group>;
  return <Group clip={clip}>{strands}</Group>;
}
