import { useMemo } from "react";
import { Circle, Shader, Skia } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import { ORB_PALETTE, rgbaOf } from "./orbTokens";
import { ORB_VOLUME_SKSL } from "./shaders/orbVolume";

/**
 * The lit interior volume of the lens.
 *
 * This is the pass that keeps the object from reading as a flat black disc. It
 * is transparent, sits between the interior ribbon and the shell, and carries
 * broad copper illumination plus two asymmetric warm lobes.
 */
export function OrbVolume({
  centerX,
  centerY,
  radius,
  energySV,
  volumeIntensity,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly energySV: SharedValue<number>;
  readonly volumeIntensity: number;
}) {
  const effect = useMemo(() => {
    try {
      return Skia.RuntimeEffect.Make(ORB_VOLUME_SKSL);
    } catch {
      return null;
    }
  }, []);

  const colors = useMemo(
    () => ({
      deep: rgbaOf(ORB_PALETTE.deep),
      copper: rgbaOf(ORB_PALETTE.copper),
      peach: rgbaOf(ORB_PALETTE.peach),
    }),
    [],
  );

  const uniforms = useDerivedValue(
    () => ({
      center: [centerX, centerY],
      radius,
      volumeIntensity,
      energy: energySV.value,
      deepColor: colors.deep,
      copperColor: colors.copper,
      peachColor: colors.peach,
    }),
    [centerX, centerY, colors, energySV, radius, volumeIntensity],
  );

  if (effect === null) {
    return null;
  }

  return (
    <Circle cx={centerX} cy={centerY} r={radius}>
      <Shader source={effect} uniforms={uniforms} />
    </Circle>
  );
}
