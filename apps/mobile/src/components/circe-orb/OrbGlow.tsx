import { useMemo } from "react";
import { Circle, Group, RadialGradient, useClock, vec } from "@shopify/react-native-skia";
import { useDerivedValue } from "react-native-reanimated";

import {
  ORB_APPEARANCE,
  ORB_MOTION,
  ORB_PALETTE,
  alphaColor,
  type OrbAppearance,
} from "./orbTokens";

/**
 * Atmospheric bloom, drawn before everything else.
 *
 * Two passes and neither is a ring: a broad diffuse peach atmosphere that
 * spills roughly a quarter of the sphere's radius past its hull, and a narrow
 * warm glow hugging the shell. Ring-shaped peaks read as concentric outlines,
 * which is wrong here.
 *
 * Both passes bake their alpha into the gradient's color stops. Neither uses
 * `opacity` or `BlurMask`: on some Android GPUs those make Skia allocate a
 * layer, and layers render as soft-edged squares around a glow. Breathing is
 * expressed by animating radius, which allocates nothing.
 */
export function OrbGlow({
  centerX,
  centerY,
  radius,
  bloomIntensity,
  appearance,
  reducedMotion,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly bloomIntensity: number;
  readonly appearance: OrbAppearance;
  readonly reducedMotion: boolean;
}) {
  const clock = useClock();
  const peak = bloomIntensity * ORB_APPEARANCE[appearance].bloomScale;

  const atmosphereColors = useMemo(
    () => [
      alphaColor(ORB_PALETTE.peach, peak * 0.08),
      alphaColor(ORB_PALETTE.peach, peak * 0.13),
      alphaColor(ORB_PALETTE.peach, 0),
    ],
    [peak],
  );
  const shellGlowColors = useMemo(
    () => [
      alphaColor(ORB_PALETTE.copper, 0),
      alphaColor(ORB_PALETTE.copper, peak * 0.24),
      alphaColor(ORB_PALETTE.peach, 0),
    ],
    [peak],
  );

  const swell = useDerivedValue(() => {
    if (reducedMotion) return 0.5;
    const t = clock.value / 1000;
    return 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / (ORB_MOTION.bloomPeriodMs / 1000));
  }, [clock, reducedMotion]);

  const atmosphereR = useDerivedValue(() => radius * (1.4 + swell.value * 0.05), [radius, swell]);
  const shellGlowR = useDerivedValue(() => radius * (1.14 + swell.value * 0.02), [radius, swell]);

  return (
    <Group>
      <Circle cx={centerX} cy={centerY} r={atmosphereR}>
        <RadialGradient
          c={vec(centerX, centerY)}
          r={atmosphereR}
          colors={atmosphereColors}
          positions={[0, 0.72, 1]}
        />
      </Circle>
      <Circle cx={centerX} cy={centerY} r={shellGlowR}>
        <RadialGradient
          c={vec(centerX, centerY)}
          r={shellGlowR}
          colors={shellGlowColors}
          positions={[0.74, 0.94, 1]}
        />
      </Circle>
    </Group>
  );
}
