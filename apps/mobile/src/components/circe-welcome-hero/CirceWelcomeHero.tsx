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
import { useDerivedValue } from "react-native-reanimated";

import { HeroBackgroundArcs } from "./HeroBackgroundArcs";
import { HeroOrbCore } from "./HeroOrbCore";
import { HeroParticles } from "./HeroParticles";
import { HeroRibbonField } from "./HeroRibbonField";
import {
  HERO_APPEARANCE,
  HERO_METRICS,
  HERO_PALETTE,
  HERO_RIBBON_CYCLE_SECONDS,
  heroAlpha,
  type HeroAppearance,
} from "./heroTokens";

/**
 * The Circe welcome hero.
 *
 * This is a brand illustration, not a product orb. It exists only on the
 * welcome and auth screens, it has no voice states, and it is deliberately a
 * wide piece of artwork rather than a widget: the orb is the focal point of a
 * scene that also contains halo arcs, atmosphere, a ribbon fan and dust.
 *
 * It is a separate component from `CirceOrb` on purpose. Trying to make one
 * shared component satisfy both a small stateful product indicator and a large
 * editorial hero produced compromises in both directions.
 *
 * One canvas, one composition, and this layer order:
 *
 *   1. broad atmospheric bloom
 *   2. halo arcs
 *   3. rear ribbon fan
 *   4. orb group
 *        a. luminous orb core
 *        b. interior ribbon, clipped and refracted through the glass
 *   5. front ribbon filaments
 *   6. dust motes
 *
 * The interior ribbon must sit over the core but inside the composition, which
 * is what makes the strands look like they pass through the object.
 *
 * Motion is slow and continuous. Nothing here is driven by app state.
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

  // One shared driver for the entire ribbon fan, advanced by wall-clock time so
  // the drift is identical on every refresh rate.
  const ribbonPhase = useDerivedValue(() => {
    if (reducedMotion) return 0;
    const t = clock.value / 1000;
    return ((t / HERO_RIBBON_CYCLE_SECONDS) * Math.PI * 2) % (Math.PI * 2);
  }, [clock, reducedMotion]);

  const sphereClip = useMemo(
    () => Skia.Path.Circle(centerX, centerY, radius),
    [centerX, centerY, radius],
  );

  // The last stop must reach zero before the canvas edge, otherwise the
  // gradient is cut off and leaves a faint horizontal seam across the page.
  const atmosphereColors = useMemo(
    () => [
      heroAlpha(HERO_PALETTE.peach, 0.17 * tuning.glowScale),
      heroAlpha(HERO_PALETTE.ribbonCopper, 0.1 * tuning.glowScale),
      heroAlpha(HERO_PALETTE.ribbonCopper, 0),
    ],
    [tuning.glowScale],
  );

  return (
    <Canvas style={{ width, height }}>
      <Group>
        {/* 1. Broad atmosphere, so the page around the hero picks up warmth. */}
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

        {/* 3. Rear ribbon fan. */}
        <HeroRibbonField
          plane="rear"
          width={width}
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          ribbonPhase={ribbonPhase}
          appearance={appearance}
          reducedMotion={reducedMotion}
        />

        {/* 4. The orb, with the refracted ribbon inside it. */}
        <HeroOrbCore
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          reducedMotion={reducedMotion}
        />
        <HeroRibbonField
          plane="interior"
          width={width}
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          clip={sphereClip}
          ribbonPhase={ribbonPhase}
          appearance={appearance}
          reducedMotion={reducedMotion}
        />

        {/* 5. One or two filaments crossing in front. */}
        <HeroRibbonField
          plane="front"
          width={width}
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          ribbonPhase={ribbonPhase}
          appearance={appearance}
          reducedMotion={reducedMotion}
        />

        {/* 6. Dust. */}
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
