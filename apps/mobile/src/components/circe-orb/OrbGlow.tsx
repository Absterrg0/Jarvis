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
 * Ambient bloom, drawn before everything else.
 *
 * Two passes: a very faint, very large atmospheric wash, and a tighter medium
 * glow hugging the sphere. Both are radial gradients whose alpha is baked into
 * their color stops. Neither uses `opacity` or `BlurMask`: on some Android GPUs
 * those make Skia allocate a layer, and layers render as soft-edged squares
 * around a glow. Breathing is expressed by animating radius instead, which
 * allocates nothing.
 *
 * The point of these passes is that the surface around the sphere picks up a
 * little warmth. If a visible orange disc appears behind the orb, they are far
 * too strong.
 */
export function OrbGlow({
  centerX,
  centerY,
  radius,
  bloomOpacity,
  bloomRadiusScale,
  appearance,
  reducedMotion,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly bloomOpacity: number;
  readonly bloomRadiusScale: number;
  readonly appearance: OrbAppearance;
  readonly reducedMotion: boolean;
}) {
  const clock = useClock();
  const tuning = ORB_APPEARANCE[appearance];
  const peak = bloomOpacity * tuning.bloomScale;

  // Computed per mode and appearance rather than per frame, so no string
  // building ever runs inside a worklet.
  const outerColors = useMemo(
    () => [
      alphaColor(ORB_PALETTE.copper, 0),
      alphaColor(ORB_PALETTE.copper, peak * 0.15),
      alphaColor(ORB_PALETTE.copper, 0),
    ],
    [peak],
  );
  const mediumColors = useMemo(
    () => [
      alphaColor(ORB_PALETTE.warmCopper, 0),
      alphaColor(ORB_PALETTE.warmCopper, peak * 0.3),
      alphaColor(ORB_PALETTE.peach, 0),
    ],
    [peak],
  );

  const swell = useDerivedValue(() => {
    if (reducedMotion) return 0.5;
    const t = clock.value / 1000;
    return 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / (ORB_MOTION.bloomPeriodMs / 1000));
  }, [clock, reducedMotion]);

  const outerR = useDerivedValue(
    () => radius * (1.58 + swell.value * 0.07) * bloomRadiusScale,
    [radius, bloomRadiusScale, swell],
  );
  const mediumR = useDerivedValue(
    () => radius * (1.14 + swell.value * 0.03) * bloomRadiusScale,
    [radius, bloomRadiusScale, swell],
  );

  return (
    <Group>
      <Circle cx={centerX} cy={centerY} r={outerR}>
        <RadialGradient
          c={vec(centerX, centerY)}
          r={outerR}
          colors={outerColors}
          positions={[0.55, 0.83, 1]}
        />
      </Circle>
      <Circle cx={centerX} cy={centerY} r={mediumR}>
        <RadialGradient
          c={vec(centerX, centerY)}
          r={mediumR}
          colors={mediumColors}
          positions={[0.7, 0.93, 1]}
        />
      </Circle>
    </Group>
  );
}
