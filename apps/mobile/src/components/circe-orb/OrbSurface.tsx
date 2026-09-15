import { useMemo } from "react";
import {
  Circle,
  Path,
  RadialGradient,
  Shader,
  Skia,
  useClock,
  vec,
} from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import { ORB_MOTION, ORB_PALETTE, alphaColor, rgbaOf } from "./orbTokens";
import { ORB_SURFACE_SKSL } from "./shaders/orbSurface";

/**
 * The glowing sphere body.
 *
 * Primary path is a SkSL runtime effect that reconstructs the surface normal
 * per pixel and lights it, so the sphere reads as a luminous copper object with
 * a crisp ring at its hull. If the effect cannot compile (an unsupported
 * driver, or a test environment with no native Skia) this falls back to the
 * same read built from stacked gradients.
 */
export function OrbSurface({
  centerX,
  centerY,
  radius,
  levelSV,
  rimBoost,
  warmth,
  edgeDepth,
  rimPhaseSpeed,
  reducedMotion,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly levelSV: SharedValue<number>;
  readonly rimBoost: number;
  readonly warmth: number;
  readonly edgeDepth: number;
  readonly rimPhaseSpeed: number;
  readonly reducedMotion: boolean;
}) {
  const clock = useClock();

  const effect = useMemo(() => {
    try {
      return Skia.RuntimeEffect.Make(ORB_SURFACE_SKSL);
    } catch {
      return null;
    }
  }, []);

  // Static tuples, so the worklet never parses a hex string.
  const colors = useMemo(
    () => ({
      hot: rgbaOf(ORB_PALETTE.hot),
      copper: rgbaOf(ORB_PALETTE.copper),
      deep: rgbaOf(ORB_PALETTE.deep),
      rim: rgbaOf(ORB_PALETTE.rim),
    }),
    [],
  );

  const uniforms = useDerivedValue(() => {
    const phase =
      reducedMotion || rimPhaseSpeed === 0
        ? 0
        : ((clock.value % ORB_MOTION.rimTraversalMs) / ORB_MOTION.rimTraversalMs) *
          Math.PI *
          2 *
          rimPhaseSpeed;
    return {
      center: [centerX, centerY],
      radius,
      level: levelSV.value,
      rimPhase: phase,
      rimIntensity: rimBoost,
      warmth,
      edgeDepth,
      hotColor: colors.hot,
      copperColor: colors.copper,
      deepColor: colors.deep,
      rimColor: colors.rim,
    };
  }, [
    centerX,
    centerY,
    clock,
    colors,
    edgeDepth,
    levelSV,
    radius,
    reducedMotion,
    rimBoost,
    rimPhaseSpeed,
    warmth,
  ]);

  if (effect !== null) {
    return (
      <Circle cx={centerX} cy={centerY} r={radius}>
        <Shader source={effect} uniforms={uniforms} />
      </Circle>
    );
  }

  // Gradient fallback. Alpha is baked into colors rather than set through
  // `opacity`, which would allocate a layer with square bounds.
  return (
    <>
      <Circle cx={centerX} cy={centerY} r={radius}>
        <RadialGradient
          c={vec(centerX - radius * 0.12, centerY - radius * 0.16)}
          r={radius * 1.18}
          colors={[ORB_PALETTE.hot, ORB_PALETTE.copper, ORB_PALETTE.deep]}
          positions={[0, 0.55, 1]}
        />
      </Circle>
      <Path
        path={Skia.Path.Circle(centerX, centerY, radius * 0.995)}
        style="stroke"
        strokeWidth={2.2}
        color={alphaColor(ORB_PALETTE.rim, 0.1 * rimBoost)}
      />
      <Path
        path={Skia.Path.Circle(centerX, centerY, radius * 0.995)}
        style="stroke"
        strokeWidth={1.2}
        color={alphaColor(ORB_PALETTE.rim, 0.7 * rimBoost)}
      />
    </>
  );
}
