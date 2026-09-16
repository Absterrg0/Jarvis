import { Image } from "react-native";

/**
 * The Circe welcome hero.
 *
 * This is a single art-directed illustration, not a renderer. It is the
 * approved reference composition: the luminous orb, the woven mesh passing
 * through it, the halo arcs, the particles and the warm atmosphere were drawn
 * as one plate, because the relationships between them are the design. The
 * ribbon's width is deliberate, the left and right fans differ, strands cross
 * and change depth, and the highlights are placed against specific negative
 * space. Reconstructing those independently and compositing them at runtime
 * produced a bent sheet of parallel strands around a lit ball: the parts were
 * present and the design was not.
 *
 * It is welcome and auth only, has no voice states, and is deliberately static.
 * An earlier revision drifted the mesh and swept a highlight along it; for a
 * brand illustration, movement should come from light rather than geometry, and
 * only after the still frame matches the reference.
 *
 * A plain React Native image rather than a Skia canvas, because there is no
 * longer any Skia content to compose with.
 */
export function CirceWelcomeHero({ width }: { readonly width: number }) {
  return (
    <Image
      source={require("../../../assets/circe/welcome-hero-base.png")}
      // Native plate aspect. Rendering at the plate's own ratio keeps the
      // composition exactly as drawn, with no crop and no distortion.
      style={{ width, height: width / WELCOME_HERO_ASPECT }}
      resizeMode="contain"
      // The wordmark above already announces the brand; this is decoration.
      accessible={false}
      importantForAccessibility="no"
    />
  );
}

/** Source plate is 1536x1024. */
export const WELCOME_HERO_ASPECT = 1536 / 1024;
