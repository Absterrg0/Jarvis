import { Image, useImage } from "@shopify/react-native-skia";

import { HERO_ASSET_SPHERE_SCALE } from "./heroTokens";

/**
 * The warm copper-brown body of the hero orb.
 *
 * A baked layer rather than a radial shader. Radius-driven ramps cannot express
 * directional lighting, a shell rim or a specular streak, so a sphere built
 * from them reads as concentric bands.
 *
 * Contains the body volume, internal tonal variation, and the faint suspended
 * specks. No page glow and no rim: those belong to the shell layer.
 *
 * Drawn larger than the sphere by `HERO_ASSET_SPHERE_SCALE`, because the asset
 * reserves margin for the shell's outward bloom.
 */
export function HeroOrbBody({
  centerX,
  centerY,
  radius,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
}) {
  const image = useImage(require("../../../assets/circe/hero-orb-body.png"));
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
