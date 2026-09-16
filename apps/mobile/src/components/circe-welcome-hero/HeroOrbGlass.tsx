import { Image, useImage } from "@shopify/react-native-skia";

/**
 * The transparent shell over the hero orb.
 *
 * Painted after the clipped interior ribbon so the strands genuinely sit inside
 * the glass: the shell's Fresnel rim and specular lobes fall over them the way
 * they would over anything seen through a curved transparent surface.
 *
 * The face of this layer is almost entirely clear. An earlier revision added a
 * broad sheen across it, which fogged the body and made the sphere look like
 * polished metal instead of glass over warm copper.
 */
export function HeroOrbGlass({
  centerX,
  centerY,
  radius,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
}) {
  const image = useImage(require("../../../assets/hero/hero-orb-glass.webp"));
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
