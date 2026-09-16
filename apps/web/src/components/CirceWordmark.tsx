import type { HTMLAttributes } from "react";

import { cn } from "../lib/utils";

/**
 * CIRCE wordmark for web chrome, matching the reference header: spaced
 * capitals in a semibold sans. Serif is reserved for display moments
 * (greetings, empty states), not persistent chrome.
 */
export function CirceWordmark(props: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      className={cn("font-semibold tracking-[0.22em]", props.className)}
      aria-label="Circe"
    >
      CIRCE
    </span>
  );
}
