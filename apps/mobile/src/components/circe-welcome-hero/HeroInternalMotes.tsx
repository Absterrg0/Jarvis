import { useMemo } from "react";
import { Circle, Group } from "@shopify/react-native-skia";

import { HERO_METRICS, HERO_PALETTE, heroAlpha, heroHash } from "./heroTokens";

/**
 * Discrete light motes suspended inside the body.
 *
 * These replace the full-surface hash grain an earlier revision used. Grain
 * across the whole sphere reads as noise or dithering and breaks up the volume;
 * a small number of distinct points reads as light caught in the material.
 *
 * Positions are deterministic and static. They are a texture detail, not a
 * moving element: the illustration's motion belongs to the ribbon highlight and
 * the atmosphere.
 */
export function HeroInternalMotes({
  centerX,
  centerY,
  radius,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
}) {
  const motes = useMemo(
    () =>
      Array.from({ length: HERO_METRICS.internalMoteCount }, (_, index) => {
        // Square-root radial distribution keeps the motes evenly spread over
        // the disc instead of clustering at the centre.
        const angle = heroHash(index, 71) * Math.PI * 2;
        const distance = Math.sqrt(heroHash(index, 72)) * radius * 0.8;
        const warmth = heroHash(index, 73);
        return {
          index,
          x: centerX + Math.cos(angle) * distance,
          y: centerY + Math.sin(angle) * distance * 0.92,
          r: 0.7 + heroHash(index, 74) * 1.3,
          alpha: 0.16 + heroHash(index, 75) * 0.3,
          color: warmth > 0.72 ? HERO_PALETTE.hot : HERO_PALETTE.peach,
        };
      }),
    [centerX, centerY, radius],
  );

  return (
    <Group>
      {motes.map((mote) => (
        <Circle
          key={mote.index}
          cx={mote.x}
          cy={mote.y}
          r={mote.r}
          color={heroAlpha(mote.color, mote.alpha)}
        />
      ))}
    </Group>
  );
}
