import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";

const COPPER = "#C97857";
const PEACH = "#E8AE93";
const INK = "#2A2320";
const MUTED = "#8A7F78";

/** Small copper ring mark used on the welcome screen. */
export function CirceRingMark({ size = 30 }: { readonly size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityLabel="Circe mark">
      <Defs>
        <LinearGradient id="circe-ring" x1="0" y1="32" x2="32" y2="0">
          <Stop offset="0" stopColor={PEACH} />
          <Stop offset="0.55" stopColor={COPPER} />
          <Stop offset="1" stopColor={COPPER} />
        </LinearGradient>
      </Defs>
      <Circle cx="16" cy="16" r="11.5" fill="none" stroke="url(#circe-ring)" strokeWidth="5" />
    </Svg>
  );
}

/** Multicolor Google "G" for the sign-in button. */
export function GoogleMark({ size = 18 }: { readonly size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityLabel="Google">
      <Path
        fill="#EA4335"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
      <Path
        fill="#4285F4"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <Path
        fill="#FBBC05"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <Path
        fill="#34A853"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <Path
        fill="#4285F4"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
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

/** Shield check for the trust row. */
export function ShieldMark({
  size = 20,
  color = COPPER,
}: {
  readonly size?: number;
  readonly color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" accessibilityLabel="Private by design">
      <Path
        d="M10 1.8 16.5 4v5.2c0 4-2.8 6.9-6.5 8.3-3.7-1.4-6.5-4.3-6.5-8.3V4z M7 9.8l2.2 2.2L13.2 8"
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Stacked server for the trust row. */
export function ServerMark({
  size = 20,
  color = COPPER,
}: {
  readonly size?: number;
  readonly color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" accessibilityLabel="Across your machines">
      <Path
        d="M3 4.5h14v4H3z M3 11.5h14v4H3z M5.5 6.5h.01M5.5 13.5h.01"
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export { MUTED };
