import { useMemo } from "react";
import {
  Circle,
  Group,
  RadialGradient,
  Shader,
  Skia,
  useClock,
  vec,
} from "@shopify/react-native-skia";
import { useDerivedValue } from "react-native-reanimated";

import { HERO_PALETTE, heroRgba } from "./heroTokens";
import { HERO_ORB_SKSL } from "./shaders/heroOrb";

const EDGE_TRAVERSAL_MS = 16000;

/**
 * The hero's central luminous object.
 *
 * Deliberately not the product orb. This one is allowed to be bright, because
 * it is the illustration's focal point rather than a state indicator.
 */
export function HeroOrbCore({
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

  const effect = useMemo(() => {
    try {
      return Skia.RuntimeEffect.Make(HERO_ORB_SKSL);
    } catch {
      return null;
    }
  }, []);

  const colors = useMemo(
    () => ({
      core: heroRgba(HERO_PALETTE.core),
      warm: heroRgba(HERO_PALETTE.warm),
      copper: heroRgba(HERO_PALETTE.copper),
      peach: heroRgba(HERO_PALETTE.peach),
      hot: heroRgba(HERO_PALETTE.hot),
    }),
    [],
  );

  const uniforms = useDerivedValue(() => {
    const phase = reducedMotion
      ? 0
      : ((clock.value % EDGE_TRAVERSAL_MS) / EDGE_TRAVERSAL_MS) * Math.PI * 2;
    return {
      center: [centerX, centerY],
      radius,
      phase,
      coreColor: colors.core,
      warmColor: colors.warm,
      copperColor: colors.copper,
      peachColor: colors.peach,
      hotColor: colors.hot,
    };
  }, [centerX, centerY, clock, colors, radius, reducedMotion]);

  if (effect === null) {
    return <OrbCoreFallback centerX={centerX} centerY={centerY} radius={radius} />;
  }

  return (
    <Group>
      <Circle cx={centerX} cy={centerY} r={radius}>
        <Shader source={effect} uniforms={uniforms} />
      </Circle>
    </Group>
  );
}

/**
 * Gradient floor for a driver where the runtime effect will not compile.
 *
 * This lives in its own component on purpose. `RadialGradient` and `Shader`
 * both use hooks, so swapping them inside one component changes the hook order
 * of that component between renders. As separate components the swap is a type
 * change, which React handles by unmounting and remounting.
 */
function OrbCoreFallback({
  centerX,
  centerY,
  radius,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
}) {
  return (
    <Circle cx={centerX} cy={centerY} r={radius}>
      <RadialGradient
        c={vec(centerX - radius * 0.18, centerY + radius * 0.14)}
        r={radius * 1.12}
        colors={[
          HERO_PALETTE.core,
          HERO_PALETTE.warm,
          HERO_PALETTE.copper,
          HERO_PALETTE.peach,
          HERO_PALETTE.hot,
        ]}
        positions={[0, 0.38, 0.68, 0.92, 1]}
      />
    </Circle>
  );
}
