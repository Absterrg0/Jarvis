import { AppText as Text } from "./AppText";

/**
 * CIRCE wordmark for mobile chrome, matching the reference header: spaced
 * capitals in a semibold sans. Serif is reserved for display moments
 * (greetings, empty states), not persistent chrome.
 */
export function CirceWordmark(props: { readonly height?: number }) {
  const size = props.height ?? 15;
  return (
    <Text
      accessibilityLabel="Circe"
      className="font-t3-bold text-foreground"
      style={{ fontSize: size, letterSpacing: size * 0.22 }}
    >
      CIRCE
    </Text>
  );
}
