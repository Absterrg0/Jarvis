import { Image, View } from "react-native";

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
 * Presentation is a deliberate overflow, not a contain. The plate is drawn wider
 * than the viewport and clipped, so the sphere lands about 18% larger than a
 * full-width contain would give and the mesh tails run off both edges the way
 * they do in the reference. A contained plate leaves the tails visibly stopping
 * short of the screen edge, which reads as a pasted image rather than as a
 * full-bleed illustration.
 *
 * It is welcome and auth only, has no voice states, and is static by design.
 */
export function CirceWelcomeHero({ width }: { readonly width: number }) {
  const imageWidth = Math.min(width * HERO_SCALE, HERO_MAX_IMAGE_WIDTH);
  const imageHeight = imageWidth / WELCOME_HERO_ASPECT;
  const viewportHeight = Math.min(
    VIEWPORT_MAX_HEIGHT,
    Math.max(VIEWPORT_MIN_HEIGHT, Math.round(imageHeight * VIEWPORT_RATIO)),
  );

  return (
    <View
      style={{
        width,
        height: viewportHeight,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Image
        source={require("../../../assets/circe/welcome-hero-base.webp")}
        style={{ width: imageWidth, height: imageHeight }}
        resizeMode="contain"
        // The wordmark above already announces the brand; this is decoration.
        accessible={false}
        importantForAccessibility="no"
      />
    </View>
  );
}

/**
 * Source plate is 1536x800 after cropping the empty margins. The supplied art
 * carried roughly 250px of fully transparent space above and below the mesh,
 * which at hero scale became ~60dp of dead height and pushed the whole sign-up
 * screen into a scroll. The crop is the margins only; no artwork is removed.
 */
export const WELCOME_HERO_ASPECT = 1536 / 800;

/** Drawn wider than the viewport so the tails crop off both edges. */
const HERO_SCALE = 1.18;

/** Stops the overflow turning into an oversized orb on wide screens. */
const HERO_MAX_IMAGE_WIDTH = 500;

/** Visible band, in dp. */
const VIEWPORT_MIN_HEIGHT = 190;
const VIEWPORT_MAX_HEIGHT = 250;

/**
 * Viewport height as a fraction of the scaled plate height. Now that the plate
 * is cropped to its content there is almost nothing left to trim, so this only
 * shaves the last few dp of soft margin.
 */
const VIEWPORT_RATIO = 0.96;
