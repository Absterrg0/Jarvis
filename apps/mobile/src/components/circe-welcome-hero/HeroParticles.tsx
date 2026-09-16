import { useMemo } from "react";
import { Circle, Group, useClock } from "@shopify/react-native-skia";
import { useDerivedValue } from "react-native-reanimated";

import { HERO_METRICS, HERO_PALETTE, heroAlpha, heroHash } from "./heroTokens";

interface Mote {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly alpha: number;
  readonly driftPeriod: number;
  readonly driftPhase: number;
}

/**
 * Dust motes suspended around the hero.
 *
 * Seven motes, warm tones, low alpha, drifting a pixel or two over seconds.
 * Not a starfield and not sparkles: this reads as suspended dust in warm light,
 * and if you notice an individual mote the count is too high.
 */
export function HeroParticles({
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
  const motes = useMemo<readonly Mote[]>(
    () =>
      Array.from({ length: HERO_METRICS.particleCount }, (_, index) => {
        const angle = heroHash(index, 61) * Math.PI * 2;
        const distance = radius * (1.05 + heroHash(index, 62) * 1.15);
        return {
          index,
          x: centerX + Math.cos(angle) * distance,
          y: centerY + Math.sin(angle) * distance * 0.78,
          r: 1 + heroHash(index, 63) * 1.6,
          alpha: 0.1 + heroHash(index, 64) * 0.14,
          driftPeriod: 11 + heroHash(index, 65) * 9,
          driftPhase: heroHash(index, 66) * Math.PI * 2,
        };
      }),
    [centerX, centerY, radius],
  );

  return (
    <Group>
      {motes.map((mote) => (
        <Mote key={mote.index} mote={mote} reducedMotion={reducedMotion} />
      ))}
    </Group>
  );
}

/** One mote owns its own drift, so each hook call is a fixed, stable count. */
function Mote({ mote, reducedMotion }: { readonly mote: Mote; readonly reducedMotion: boolean }) {
  const clock = useClock();
  const drift = useDerivedValue(() => {
    if (reducedMotion) return [{ translateY: 0 }];
    const t = clock.value / 1000;
    return [{ translateY: Math.sin((2 * Math.PI * t) / mote.driftPeriod + mote.driftPhase) * 2 }];
  }, [clock, mote.driftPeriod, mote.driftPhase, reducedMotion]);

  return (
    <Group transform={drift}>
      <Circle
        cx={mote.x}
        cy={mote.y}
        r={mote.r}
        color={heroAlpha(HERO_PALETTE.ribbonPeach, mote.alpha)}
      />
    </Group>
  );
}
