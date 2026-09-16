import { useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSharedValue } from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { CirceOrb } from "../../components/circe-orb/CirceOrb";
import { CirceWelcomeHero } from "../../components/circe-welcome-hero/CirceWelcomeHero";
import type { CirceOrbState } from "../../components/circe-orb/types";
import type { OrbAppearance } from "../../components/circe-orb/orbTokens";

const STATES: ReadonlyArray<CirceOrbState> = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "success",
  "error",
];

const LEVELS: ReadonlyArray<{ readonly label: string; readonly value: number }> = [
  { label: "Silence", value: 0 },
  { label: "25%", value: 0.25 },
  { label: "75%", value: 0.75 },
];

const SIZES: ReadonlyArray<{ readonly label: string; readonly value: number }> = [
  { label: "Compact", value: 96 },
  { label: "Home", value: 168 },
  { label: "Hero", value: 236 },
];

/**
 * Development-only visual QA surface for the orb.
 *
 * Quality is judged at zero frames per second first: a static frame has to
 * look right before any motion is allowed to compensate for it. This screen
 * exists so every mode, both appearances, three sizes, and three audio levels
 * can be compared side by side without rebuilding constants.
 *
 * Registered only in development builds.
 */
export function OrbGalleryRouteScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [appearance, setAppearance] = useState<OrbAppearance>("light");
  const [levelValue, setLevelValue] = useState(0.75);
  const [size, setSize] = useState(168);
  const level = useSharedValue(0.75);

  const background = appearance === "light" ? "#FAF7F3" : "#0B0B0C";
  const text = appearance === "light" ? "#241D18" : "#F6F2EF";

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: background }}
      contentContainerStyle={{
        gap: 20,
        paddingVertical: 20,
        paddingTop: insets.top + 12,
        paddingBottom: Math.max(insets.bottom, 24),
      }}
    >
      <Text style={{ color: text, fontSize: 20, fontWeight: "700", paddingHorizontal: 20 }}>
        Orb gallery
      </Text>

      <Row label="Appearance" text={text}>
        {(["light", "dark"] as const).map((value) => (
          <Chip
            key={value}
            label={value}
            active={appearance === value}
            text={text}
            onPress={() => setAppearance(value)}
          />
        ))}
      </Row>

      <Row label="Audio level" text={text}>
        {LEVELS.map((entry) => (
          <Chip
            key={entry.label}
            label={entry.label}
            active={levelValue === entry.value}
            text={text}
            onPress={() => {
              level.value = entry.value;
              setLevelValue(entry.value);
            }}
          />
        ))}
      </Row>

      <Row label="Size" text={text}>
        {SIZES.map((entry) => (
          <Chip
            key={entry.label}
            label={entry.label}
            active={size === entry.value}
            text={text}
            onPress={() => setSize(entry.value)}
          />
        ))}
      </Row>

      {/* The welcome hero is a different visual system from the product orb: a
          single static illustration rather than a stateful widget. It is
          surfaced here so it can be inspected without needing a signed-out
          session, since the welcome route redirects as soon as one exists. */}
      <View style={{ gap: 6 }}>
        <Text style={{ color: text, fontSize: 12, fontWeight: "600", paddingHorizontal: 20 }}>
          Welcome hero (brand illustration)
        </Text>
        <CirceWelcomeHero width={width} />
      </View>

      {STATES.map((state) => (
        <View key={state} style={{ alignItems: "center", gap: 6 }}>
          <Text
            style={{ color: text, fontSize: 12, fontWeight: "600", textTransform: "capitalize" }}
          >
            {state}
          </Text>
          <CirceOrb state={state} size={size} level={level} appearance={appearance} width={width} />
        </View>
      ))}
    </ScrollView>
  );
}

function Row({
  label,
  text,
  children,
}: {
  readonly label: string;
  readonly text: string;
  readonly children: React.ReactNode;
}) {
  return (
    <View style={{ gap: 8, paddingHorizontal: 20 }}>
      <Text style={{ color: text, fontSize: 12, fontWeight: "600", opacity: 0.7 }}>{label}</Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>{children}</View>
    </View>
  );
}

function Chip({
  label,
  active,
  text,
  onPress,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly text: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        borderWidth: 1,
        borderColor: active ? "#C97857" : `${text}33`,
        backgroundColor: active ? "#C97857" : "transparent",
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
      }}
    >
      <Text style={{ color: active ? "#FFFDF9" : text, fontSize: 12, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}
