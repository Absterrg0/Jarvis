import type { SharedValue } from "react-native-reanimated";

import type { OrbAppearance } from "./orbTokens";

export type CirceOrbState = "idle" | "listening" | "thinking" | "speaking" | "success" | "error";

export interface CirceOrbProps {
  /** Current assistant state. Drives the whole parameter preset. */
  readonly state: CirceOrbState;
  /** Sphere diameter in points, excluding the fiber field. */
  readonly size?: number;
  /**
   * Normalized audio/activity intensity, 0..1. Accepts a Reanimated shared
   * value for frame-rate updates without React renders, or a plain number.
   */
  readonly level?: number | SharedValue<number>;
  /**
   * Light or dark treatment. The geometry is identical; only luminosity
   * changes, so a dark surface leans on the rim instead of a large bloom.
   */
  readonly appearance?: OrbAppearance;
  /**
   * Draw the fiber field around the sphere. Disable for compact placements
   * where the surrounding strands would be clipped or distracting.
   */
  readonly showField?: boolean;
  /** Canvas width for the fiber field. Defaults to the window width. */
  readonly width?: number;
  readonly interactive?: boolean;
  readonly reducedMotion?: boolean;
  readonly onPress?: () => void;
  /** Accessibility label for the press target. */
  readonly accessibilityLabel?: string;
}
