import { useMemo } from "react";
import { Circle, Group, useClock } from "@shopify/react-native-skia";
import { useDerivedValue } from "react-native-reanimated";

import { HERO_METRICS, HERO_MOTION, HERO_PALETTE, heroAlpha, heroHash } from "./heroTokens";

/**
 * Halo arcs behind the orb.
 *
 * A few large, very faint concentric rings. They exist to give the hero a
 * designed composition instead of a single object floating on an empty page.
 * At these alphas they should be felt rather than counted, and if you can
 * clearly see a ring it is too strong.
 */
export function HeroHaloArcs({
  centerX,
  centerY,
  radius,
  reducedMotion,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly reducedMotion: boolean;
}) {
  const clock = useClock();

  const arcs = useMemo(
    () =>
      Array.from({ length: HERO_METRICS.arcCount }, (_, index) => ({
        index,
        // Kept inside the canvas: the outermost ring must not be sliced by the
        // hero's own top edge, which reads as a rendering fault.
        scale: 1.05 + index * 0.1 + heroHash(index, 51) * 0.04,
        alpha: 0.1 - index * 0.022,
        offsetX: (heroHash(index, 52) - 0.5) * radius * 0.22,
        offsetY: (heroHash(index, 53) - 0.5) * radius * 0.16,
        // Flattened into ellipses. Perfect circles read as a technical diagram.
        squash: 0.7 + heroHash(index, 55) * 0.14,
        width: 0.9 + heroHash(index, 54) * 0.5,
      })),
    [],
  );

  // A very slow breath so the arcs feel alive without moving to the eye.
  const breatheScale = useDerivedValue(() => {
    if (reducedMotion) return 1;
    const t = clock.value / 1000;
    return 1 + Math.sin((2 * Math.PI * t) / HERO_MOTION.breathSeconds) * 0.012;
  }, [clock, reducedMotion]);
  const breatheTransform = useDerivedValue(() => [{ scale: breatheScale.value }], [breatheScale]);

  return (
    <Group origin={{ x: centerX, y: centerY }} transform={breatheTransform}>
      {arcs.map((arc) => (
        <Group
          key={arc.index}
          origin={{ x: centerX + arc.offsetX, y: centerY + arc.offsetY }}
          transform={[{ scaleY: arc.squash }]}
        >
          <Circle
            cx={centerX + arc.offsetX}
            cy={centerY + arc.offsetY}
            r={radius * arc.scale}
            style="stroke"
            strokeWidth={arc.width}
            color={heroAlpha(HERO_PALETTE.ribbonCopper, arc.alpha)}
          />
        </Group>
      ))}
    </Group>
  );
}
