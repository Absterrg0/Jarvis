import { useMemo } from "react";
import { Circle, Group, RadialGradient, useClock, vec } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

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
 * Three separate fields, because one broad gradient cannot be simultaneously
 * broad and present:
 *
 *   A. ~1.55R  broad peach atmosphere, the light spilling onto the page
 *   B. ~1.22R  medium warm bloom hugging the object
 *   C. ~1.05R  localized shell aura
 *
 * None of them is a ring: ring-shaped peaks read as concentric outlines.
 *
 * The field is driven by microphone energy through `energySV`. An earlier
 * version documented bloom as audio-responsive while never passing the level
 * in, so the claim was false; the alpha now genuinely rises with energy.
 *
 * Alpha is baked into the gradient stops on the UI thread. Neither `opacity`
 * nor `BlurMask` is used: on some Android GPUs both make Skia allocate a layer,
 * and layers render as soft-edged squares around a glow.
 */
export function OrbGlow({
  centerX,
  centerY,
  radius,
  bloomIntensity,
  energySV,
  appearance,
  reducedMotion,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly bloomIntensity: number;
  readonly energySV: SharedValue<number>;
  readonly appearance: OrbAppearance;
  readonly reducedMotion: boolean;
}) {
  const clock = useClock();
  const peak = bloomIntensity * ORB_APPEARANCE[appearance].bloomScale;

  // The broad atmosphere is centred slightly above the object, matching the
  // reference where the page is lit from the upper part of the globe.
  const atmosphereCenter = useMemo(
    () => vec(centerX, centerY - radius * 0.08),
    [centerX, centerY, radius],
  );

  const atmosphereColors = useDerivedValue(() => {
    const gain = peak * (1 + energySV.value * 0.2);
    return [
      alphaColor(ORB_PALETTE.peach, gain * 0.04),
      alphaColor(ORB_PALETTE.peach, gain * 0.1),
      alphaColor(ORB_PALETTE.peach, 0),
    ];
  }, [energySV, peak]);

  const bloomColors = useDerivedValue(() => {
    const gain = peak * (1 + energySV.value * 0.25);
    return [
      alphaColor(ORB_PALETTE.copper, 0),
      alphaColor(ORB_PALETTE.copper, gain * 0.17),
      alphaColor(ORB_PALETTE.peach, 0),
    ];
  }, [energySV, peak]);

  const shellAuraColors = useDerivedValue(() => {
    const gain = peak * (1 + energySV.value * 0.35);
    return [
      alphaColor(ORB_PALETTE.copper, 0),
      alphaColor(ORB_PALETTE.peach, gain * 0.26),
      alphaColor(ORB_PALETTE.peach, 0),
    ];
  }, [energySV, peak]);

  const swell = useDerivedValue(() => {
    if (reducedMotion) return 0.5;
    const t = clock.value / 1000;
    return 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / (ORB_MOTION.bloomPeriodMs / 1000));
  }, [clock, reducedMotion]);

  const atmosphereR = useDerivedValue(() => radius * (1.55 + swell.value * 0.06), [radius, swell]);
  const bloomR = useDerivedValue(() => radius * (1.22 + swell.value * 0.04), [radius, swell]);
  const shellAuraR = useDerivedValue(() => radius * (1.05 + swell.value * 0.02), [radius, swell]);

  return (
    <Group>
      {/* A. Broad atmosphere. This is what lights the page around Circe. */}
      <Circle cx={centerX} cy={centerY} r={atmosphereR}>
        <RadialGradient
          c={atmosphereCenter}
          r={atmosphereR}
          colors={atmosphereColors}
          positions={[0.3, 0.62, 1]}
        />
      </Circle>

      {/* B. Medium warm bloom. */}
      <Circle cx={centerX} cy={centerY} r={bloomR}>
        <RadialGradient
          c={vec(centerX, centerY)}
          r={bloomR}
          colors={bloomColors}
          positions={[0.7, 0.92, 1]}
        />
      </Circle>

      {/* C. Localized shell aura. */}
      <Circle cx={centerX} cy={centerY} r={shellAuraR}>
        <RadialGradient
          c={vec(centerX, centerY)}
          r={shellAuraR}
          colors={shellAuraColors}
          positions={[0.82, 0.96, 1]}
        />
      </Circle>
    </Group>
  );
}
