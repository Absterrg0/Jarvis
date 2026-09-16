import { useMemo } from "react";
import { Circle, Shader, Skia } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import { ORB_PALETTE, rgbaOf } from "./orbTokens";
import { ORB_BASE_SKSL } from "./shaders/orbBase";

/**
 * The dark absorptive body of the sphere.
 *
 * Drawn first, fully opaque. It is the layer that makes the object feel heavy,
 * and the layer the refracted interior fibers are sandwiched against.
 *
 * If the effect cannot compile (an unsupported driver, or a test environment
 * with no native Skia) this degrades to a plain dark disc, which still holds
 * the composition together.
 */
export function OrbBase({
  centerX,
  centerY,
  radius,
  energySV,
  coreWarmth,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly energySV: SharedValue<number>;
  readonly coreWarmth: number;
}) {
  const effect = useMemo(() => {
    try {
      return Skia.RuntimeEffect.Make(ORB_BASE_SKSL);
    } catch {
      return null;
    }
  }, []);

  const colors = useMemo(
    () => ({
      core: rgbaOf(ORB_PALETTE.core),
      coreWarm: rgbaOf(ORB_PALETTE.coreWarm),
      ember: rgbaOf(ORB_PALETTE.ember),
    }),
    [],
  );

  const uniforms = useDerivedValue(
    () => ({
      center: [centerX, centerY],
      radius,
      coreWarmth,
      energy: energySV.value,
      coreColor: colors.core,
      coreWarmColor: colors.coreWarm,
      emberColor: colors.ember,
    }),
    [centerX, centerY, colors, coreWarmth, energySV, radius],
  );

  if (effect !== null) {
    return (
      <Circle cx={centerX} cy={centerY} r={radius}>
        <Shader source={effect} uniforms={uniforms} />
      </Circle>
    );
  }

  return <Circle cx={centerX} cy={centerY} r={radius} color={ORB_PALETTE.core} />;
}
