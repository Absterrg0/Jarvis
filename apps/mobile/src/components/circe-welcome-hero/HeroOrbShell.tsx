import { Image, useImage } from "@shopify/react-native-skia";

import { HERO_ASSET_SPHERE_SCALE } from "./heroTokens";

/**
 * The luminous shell over the hero orb.
 *
 * Painted after the clipped interior mesh so the strands genuinely sit inside
 * the glass: the rim, bloom and highlight streak fall over them the way they
 * would over anything seen through a curved transparent surface.
 *
 * The face is almost entirely clear, so the shell adds a rim and a streak
 * without flattening the body's depth.
 */
export function HeroOrbShell({
  centerX,
  centerY,
  radius,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
}) {
  const image = useImage(require("../../../assets/circe/hero-orb-shell.png"));
  if (image === null) return null;
  const size = (radius * 2) / HERO_ASSET_SPHERE_SCALE;
  return (
    <Image
      image={image}
      x={centerX - size / 2}
      y={centerY - size / 2}
      width={size}
      height={size}
      fit="contain"
    />
  );
}
