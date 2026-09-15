import { useMemo } from "react";
import { Circle, Shader, Skia, useClock } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import { ORB_MOTION, ORB_PALETTE, rgbaOf } from "./orbTokens";
import { ORB_SHELL_SKSL } from "./shaders/orbShell";

/**
 * The transparent shell: hull light, a thin lip, and nothing else.
 *
 * Drawn after the refracted interior fibers so they sit *inside* the glass
 * rather than on top of a painted sphere. There is no separate circular stroke
 * anywhere: the uneven angular profile in this pass is the ring.
 *
 * The phase travels slowly around the circumference, which is what keeps a
 * still object feeling alive.
 */
export function OrbShell({
  centerX,
  centerY,
  radius,
  energySV,
  shellIntensity,
  reducedMotion,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly energySV: SharedValue<number>;
  readonly shellIntensity: number;
  readonly reducedMotion: boolean;
}) {
  const clock = useClock();

  const effect = useMemo(() => {
    try {
      return Skia.RuntimeEffect.Make(ORB_SHELL_SKSL);
    } catch {
      return null;
    }
  }, []);

  const colors = useMemo(
    () => ({
      deep: rgbaOf(ORB_PALETTE.deep),
      copper: rgbaOf(ORB_PALETTE.copper),
      peach: rgbaOf(ORB_PALETTE.peach),
      hot: rgbaOf(ORB_PALETTE.hot),
    }),
    [],
  );

  const uniforms = useDerivedValue(() => {
    const phase = reducedMotion
      ? 0
      : ((clock.value % ORB_MOTION.shellTraversalMs) / ORB_MOTION.shellTraversalMs) * Math.PI * 2;
    return {
      center: [centerX, centerY],
      radius,
      shellPhase: phase,
      shellIntensity,
      energy: energySV.value,
      deepColor: colors.deep,
      copperColor: colors.copper,
      peachColor: colors.peach,
      hotColor: colors.hot,
    };
  }, [centerX, centerY, clock, colors, energySV, radius, reducedMotion, shellIntensity]);

  if (effect !== null) {
    return (
      <Circle cx={centerX} cy={centerY} r={radius * 1.002}>
        <Shader source={effect} uniforms={uniforms} />
      </Circle>
    );
  }

  return (
    <Circle
      cx={centerX}
      cy={centerY}
      r={radius}
      style="stroke"
      strokeWidth={1.2}
      color={ORB_PALETTE.peach}
      opacity={0.5 * shellIntensity}
    />
  );
}
