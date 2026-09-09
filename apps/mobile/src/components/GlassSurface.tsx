import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import {
  Platform,
  View,
  type ColorValue,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { useThemeColor } from "../lib/useThemeColor";
import { ARIS_PANEL_RADIUS } from "../lib/layoutMetrics";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

interface GlassSurfaceProps extends Omit<ViewProps, "className"> {
  readonly children: ReactNode;
  readonly glassEffectStyle?: "clear" | "regular" | "none";
  readonly tintColor?: ColorValue;
  readonly chrome?: "default" | "none";
  /** Styling used only when native Liquid Glass is unavailable. */
  readonly fallbackStyle?: StyleProp<ViewStyle>;
}

export function GlassSurface({
  children,
  glassEffectStyle = "regular",
  chrome = "default",
  tintColor,
  fallbackStyle,
  style,
  ...props
}: GlassSurfaceProps) {
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";
  const borderColor = useThemeColor("--color-border");
  const glassSurface = useThemeColor("--color-glass-surface");
  const glassTint = useThemeColor("--color-glass-tint");
  const supportsGlass = Platform.OS === "ios" && isGlassEffectAPIAvailable();
  const surfaceStyle: ViewStyle = {
    borderRadius: ARIS_PANEL_RADIUS,
    overflow: "hidden",
    borderWidth: chrome === "none" ? 0 : 1,
    borderColor: chrome === "none" ? "transparent" : borderColor,
    backgroundColor: chrome === "none" ? "transparent" : glassSurface,
    // ARIS surfaces are solid with a crisp 1px rule. No drop shadow: depth
    // comes from the graphite/paper step, not elevation.
    shadowColor: "#000000",
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: {
      width: 0,
      height: 0,
    },
    elevation: 0,
  };

  if (supportsGlass) {
    return (
      <GlassView
        {...props}
        glassEffectStyle={glassEffectStyle}
        tintColor={String(tintColor ?? glassTint)}
        colorScheme={isDarkMode ? "dark" : "light"}
        style={[surfaceStyle, style]}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View {...props} style={[surfaceStyle, fallbackStyle, style]}>
      {children}
    </View>
  );
}
