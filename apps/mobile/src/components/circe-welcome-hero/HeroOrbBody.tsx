import { Image, useImage } from "@shopify/react-native-skia";

/**
 * The opaque volumetric body of the hero orb.
 *
 * This is a baked asset rather than a radial shader. Radius-driven ramps cannot
 * express asymmetric directional lighting, a Fresnel rim or a specular lobe, so
 * a sphere built from them reads as concentric bands. The asset is shaded from
 * the reconstructed sphere normal instead, and it is hero-only: `CirceOrb` stays
 * fully procedural for product states.
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
  const image = useImage(require("../../../assets/hero/hero-orb-body.webp"));
  if (image === null) return null;
  return (
    <Image
      image={image}
      x={centerX - radius}
      y={centerY - radius}
      width={radius * 2}
      height={radius * 2}
      fit="contain"
    />
  );
}
