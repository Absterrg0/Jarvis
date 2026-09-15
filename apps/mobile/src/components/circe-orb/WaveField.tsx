import { useMemo } from "react";
import {
  Group,
  LinearGradient,
  Path,
  Skia,
  usePathInterpolation,
  vec,
  type SkPath,
} from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import { ORB_PALETTE, ORB_APPEARANCE, alphaColor, hash01, type OrbAppearance } from "./orbTokens";
import type { OrbStateParams } from "./orbState";

/**
 * A single silk filament.
 *
 * These are filaments, not an audio waveform and not an equalizer. Each strand
 * takes deterministic variation from `hash01`, so twenty of them never look
 * cloned, and most should be barely perceptible: collectively they form the
 * object rather than reading as twenty separate lines.
 */
interface StrandSpec {
  readonly index: number;
  readonly frequency: number;
  readonly amplitude: number;
  readonly phase: number;
  readonly yOffset: number;
  readonly width: number;
  readonly alpha: number;
  readonly color: string;
  readonly speedScale: number;
}

const OVERSCAN = 120;
const SEGMENTS = 120;
const MORPH_STEPS = 3;

export type StrandPlane = "rear" | "interior" | "front";

const PLANE_COUNT: Record<StrandPlane, number> = { rear: 18, interior: 20, front: 5 };
const PLANE_SPREAD: Record<StrandPlane, number> = { rear: 0.85, interior: 0.2, front: 0.3 };
/** Interior strands sit in a tight band, so they read as one refracting lens. */
const PLANE_AMPLITUDE: Record<StrandPlane, number> = { rear: 1, interior: 1.55, front: 1.1 };

function buildSpecs(plane: StrandPlane, radius: number): StrandSpec[] {
  const count = PLANE_COUNT[plane];
  // Interior and front strands are the ones the eye follows, so they carry
  // more presence than the rear field.
  const presence = plane === "rear" ? 1.5 : plane === "interior" ? 2.1 : 2.2;
  const specs: StrandSpec[] = [];
  for (let index = 0; index < count; index += 1) {
    const accent = index % 5 === 0;
    specs.push({
      index,
      frequency: 0.0031 * (1 + (hash01(index, 1) - 0.5) * 0.36),
      amplitude: (6 + hash01(index, 2) * 11) * (accent ? 1.2 : 1) * PLANE_AMPLITUDE[plane],
      phase: hash01(index, 3) * Math.PI * 2,
      yOffset: (hash01(index, 4) - 0.5) * 2 * radius * PLANE_SPREAD[plane],
      width: accent ? 0.9 + hash01(index, 5) * 0.3 : 0.6 + hash01(index, 5) * 0.28,
      alpha: (accent ? 0.3 + hash01(index, 6) * 0.2 : 0.14 + hash01(index, 6) * 0.18) * presence,
      color: accent
        ? ORB_PALETTE.hot
        : index % 2 === 0
          ? ORB_PALETTE.warmCopper
          : ORB_PALETTE.peach,
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
 * exactly double the primary frequency, which makes the strand wrap seamlessly
 * once its phase advances a full period.
 */
function buildStrandPath(
  spec: StrandSpec,
  phase: number,
  width: number,
  centerX: number,
  centerY: number,
  radius: number,
  plane: StrandPlane,
  refraction: number,
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
    const wave = Math.sin(k * x + phase) + 0.32 * Math.sin(2 * k * x - phase * 0.7);
    let outX = x;
    let outY = restY + spec.amplitude * wave * envelope;

    if (plane === "interior") {
      // Refraction: compress toward the sphere centre and add a little lift, so
      // the fibers read as bent by a transparent gravitational field rather
      // than as fibers passing behind glass.
      const normalizedX = Math.max(-1, Math.min(1, (x - centerX) / radius));
      outX = centerX + (x - centerX) * 0.91;
      outY = centerY + (outY - centerY) * 0.82 + Math.sin(normalizedX * Math.PI) * 2.5 * refraction;
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
  levelSV,
  params,
  appearance,
}: {
  readonly spec: StrandSpec;
  readonly width: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly plane: StrandPlane;
  readonly fieldPhase: SharedValue<number>;
  readonly levelSV: SharedValue<number>;
  readonly params: OrbStateParams;
  readonly appearance: OrbAppearance;
}) {
  const refraction = params.internalActivity;
  const frames = useMemo(() => {
    const step = (Math.PI * 2) / MORPH_STEPS;
    return [0, 1, 2, 3].map((index) =>
      buildStrandPath(
        spec,
        spec.phase + index * step,
        width,
        centerX,
        centerY,
        radius,
        plane,
        refraction,
      ),
    );
  }, [spec, width, centerX, centerY, radius, plane, refraction]);

  const localPhase = useDerivedValue(
    () => (fieldPhase.value * spec.speedScale + spec.phase) % MORPH_STEPS,
    [fieldPhase, spec.speedScale, spec.phase],
  );
  const morphed = usePathInterpolation(localPhase, [0, 1, 2, 3], frames);

  const activity = plane === "interior" ? params.internalActivity : 1;
  const stretch = useDerivedValue(
    () => [{ scaleY: 1 + levelSV.value * 0.7 * activity }],
    [activity, levelSV],
  );

  const alpha = spec.alpha * params.strandOpacity * ORB_APPEARANCE[appearance].strandOpacity;
  const restY = centerY + spec.yOffset;
  const gradientStart = vec(0, restY);
  const gradientEnd = vec(width, restY);

  return (
    <Group origin={vec(centerX, restY)} transform={stretch}>
      {/* Wide faint pass stands in for a glow. A real BlurMask allocates a
          layer, which renders as a translucent rectangle on some Android GPUs. */}
      <Path
        path={morphed}
        style="stroke"
        strokeWidth={spec.width * 6}
        strokeCap="round"
        color={alphaColor(spec.color, alpha * 0.12)}
      />
      <Path
        path={morphed}
        style="stroke"
        strokeWidth={spec.width}
        strokeCap="round"
        color={alphaColor(spec.color, alpha)}
      >
        <LinearGradient
          start={gradientStart}
          end={gradientEnd}
          colors={[
            alphaColor(spec.color, 0),
            alphaColor(spec.color, alpha),
            alphaColor(ORB_PALETTE.peach, alpha),
            alphaColor(spec.color, alpha),
            alphaColor(spec.color, 0),
          ]}
          positions={[0, 0.28, 0.5, 0.72, 1]}
        />
      </Path>
    </Group>
  );
}

/**
 * One plane of the fiber field.
 *
 * `rear` renders behind the sphere, `interior` is clipped to the sphere and
 * refracted, and `front` crosses over it. Rendering the same field three times
 * is what produces the sense of depth; the eye reads three planes without any
 * real 3D rendering taking place.
 */
export function OrbStrandPlane({
  plane,
  width,
  centerX,
  centerY,
  radius,
  clip,
  fieldPhase,
  levelSV,
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
  readonly levelSV: SharedValue<number>;
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
      levelSV={levelSV}
      params={params}
      appearance={appearance}
    />
  ));

  if (clip === undefined) {
    return <Group>{strands}</Group>;
  }
  return <Group clip={clip}>{strands}</Group>;
}
