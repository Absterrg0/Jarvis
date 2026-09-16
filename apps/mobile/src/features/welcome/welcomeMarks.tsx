import { Image } from "react-native";
import Svg, { Path } from "react-native-svg";

/** Near-black used as the default mark colour. */
const INK = "#2A2320";

/**
 * The Circe brand mark.
 *
 * Rendered from the approved brand asset rather than redrawn, so the identity
 * stays consistent with every other surface. The source is 220x250, so height
 * drives the size and width follows the asset's own ratio.
 */
export function CirceMark({ height = 30 }: { readonly height?: number }) {
  return (
    <Image
      source={require("../../../assets/circe/circe-mark.png")}
      style={{ height, width: (height * 220) / 250 }}
      resizeMode="contain"
      accessibilityLabel="Circe"
    />
  );
}

/** Google's four-colour "G", in the brand's own proportions. */
export function GoogleMark({ size = 18 }: { readonly size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityLabel="Google">
      <Path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <Path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <Path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <Path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </Svg>
  );
}

/** Right arrow used inside the sign-in buttons. */
export function ArrowMark({
  size = 16,
  color = INK,
}: {
  readonly size?: number;
  readonly color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" accessibilityLabel="Continue">
      <Path
        d="M2.5 8h10M9 3.5 13.5 8 9 12.5"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Envelope for the email button. */
export function EnvelopeMark({
  size = 18,
  color = INK,
}: {
  readonly size?: number;
  readonly color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" accessibilityLabel="Email">
      <Path
        d="M2.5 4.5h15v11h-15z M2.8 5.2 10 11l7.2-5.8"
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
