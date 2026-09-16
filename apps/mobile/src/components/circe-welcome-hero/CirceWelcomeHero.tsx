import { useMemo } from "react";
import {
  Canvas,
  Circle,
  Group,
  RadialGradient,
  Skia,
  useClock,
  vec,
} from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import { HeroBackgroundArcs } from "./HeroBackgroundArcs";
import { HeroInternalMotes } from "./HeroInternalMotes";
import { HeroOrbBody } from "./HeroOrbBody";
import { HeroOrbGlass } from "./HeroOrbGlass";
import { HeroParticles } from "./HeroParticles";
import { HeroRibbonField } from "./HeroRibbonField";
import {
  HERO_APPEARANCE,
  HERO_METRICS,
  HERO_MOTION,
  HERO_PALETTE,
  heroAlpha,
  type HeroAppearance,
} from "./heroTokens";

/**
 * The Circe welcome hero.
 *
 * This is a brand illustration, not a product orb. It exists only on the
 * welcome and auth screens, it has no voice states, and it is deliberately a
 * wide piece of artwork rather than a widget. It is a separate component from
 * `CirceOrb` on purpose: one shared component cannot be both a small stateful
 * product indicator and a large editorial hero without compromising both.
 *
 * The layer order is load-bearing and is why this is composed in one place
 * rather than hidden behind an "orb" component:
 *
 *   1. atmosphere
 *   2. halo arcs
 *   3. rear ribbon          (rigid drift)
 *   4. orb body
 *   5. internal motes       (inside the body)
 *   6. interior ribbon      (clipped and refracted, rigid drift)
 *   7. orb glass            (shell over the interior ribbon)
 *   8. front ribbon         (one or two strands over the shell)
 *   9. external motes
 *
 * The glass must be painted after the interior ribbon, otherwise the strands
 * appear to sit on top of the sphere rather than inside it.
 *
 * Motion is intentionally minimal. The ribbon geometry is frozen and moves only
 * as a rigid drift of a few dp; the visible life comes from a highlight
 * travelling along the ribbon and from the atmosphere breathing. Both use slow
 * out-and-back ramps rather than a repeating cycle, so no loop boundary exists
 * that could produce a seam.
 */
export function CirceWelcomeHero({
  width,
  appearance = "light",
  reducedMotion = false,
}: {
  readonly width: number;
  readonly appearance?: HeroAppearance;
  readonly reducedMotion?: boolean;
}) {
  const clock = useClock();
  const tuning = HERO_APPEARANCE[appearance];

  const height = HERO_METRICS.height;
  const centerX = width / 2;
  const centerY = height * HERO_METRICS.centerYFraction;
  const radius = Math.min(
    HERO_METRICS.radiusMax,
    Math.max(HERO_METRICS.radiusMin, width * HERO_METRICS.radiusFraction),
  );

  // Rigid drift of the whole woven surface. Out-and-back, so its velocity is
  // zero at the extremes and there is nothing to seam.
  const ribbonDrift = useDerivedValue(() => {
    if (reducedMotion) return [{ translateY: 0 }];
    const t = clock.value / 1000;
    const phase = (2 * Math.PI * t) / HERO_MOTION.ribbonDriftSeconds;
    return [{ translateY: Math.sin(phase) * HERO_MOTION.ribbonDriftDp }];
  }, [clock, reducedMotion]);

  // Highlight travel. Also out-and-back, and symmetric, so the bright band never
  // jumps and never has to wrap.
  const highlightCenterX = useDerivedValue(() => {
    if (reducedMotion) return width * 0.5;
    const t = clock.value / 1000;
    const phase = (2 * Math.PI * t) / HERO_MOTION.highlightPeriodSeconds;
    return width * (0.5 - 0.5 * Math.cos(phase));
  }, [clock, reducedMotion, width]);

  const sphereClip = useMemo(
    () => Skia.Path.Circle(centerX, centerY, radius),
    [centerX, centerY, radius],
  );

  // The last stop must reach zero before the canvas edge, otherwise the
  // gradient is cut off and leaves a faint horizontal seam across the page.
  const atmosphereColors = useMemo(
    () => [
      heroAlpha(HERO_PALETTE.peach, 0.16 * tuning.glowScale),
      heroAlpha(HERO_PALETTE.ribbonCopper, 0.09 * tuning.glowScale),
      heroAlpha(HERO_PALETTE.ribbonCopper, 0),
    ],
    [tuning.glowScale],
  );

  return (
    <Canvas style={{ width, height }}>
      <Group>
        {/* 1. Atmosphere, so the page around the hero picks up warmth. */}
        <Circle cx={centerX} cy={centerY} r={radius * 2.1}>
          <RadialGradient
            c={vec(centerX, centerY - radius * 0.1)}
            r={radius * 2.1}
            colors={atmosphereColors}
            positions={[0.26, 0.5, 0.78]}
          />
        </Circle>

        {/* 2. Halo arcs. */}
        <HeroBackgroundArcs
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          reducedMotion={reducedMotion}
        />

        {/* 3. Rear ribbon, behind the body. */}
        <Group transform={ribbonDrift}>
          <HeroRibbonField
            plane="rear"
            width={width}
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            appearance={appearance}
            highlightCenterX={highlightCenterX}
          />
        </Group>

        {/* 4. The body. */}
        <HeroOrbBody centerX={centerX} centerY={centerY} radius={radius} />

        {/* 5. Motes suspended inside the body. */}
        <Group clip={sphereClip}>
          <HeroInternalMotes centerX={centerX} centerY={centerY} radius={radius} />
        </Group>

        {/* 6. The same ribbon, refracted through the glass. */}
        <Group transform={ribbonDrift}>
          <HeroRibbonField
            plane="interior"
            width={width}
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            clip={sphereClip}
            appearance={appearance}
            highlightCenterX={highlightCenterX}
          />
        </Group>

        {/* 7. The shell, over the interior ribbon. */}
        <HeroOrbGlass centerX={centerX} centerY={centerY} radius={radius} />

        {/* 8. A couple of strands crossing over the shell. */}
        <Group transform={ribbonDrift}>
          <HeroRibbonField
            plane="front"
            width={width}
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            appearance={appearance}
            highlightCenterX={highlightCenterX}
          />
        </Group>

        {/* 9. Dust in the air around the hero. */}
        <HeroParticles
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          reducedMotion={reducedMotion}
        />
      </Group>
    </Canvas>
  );
}
