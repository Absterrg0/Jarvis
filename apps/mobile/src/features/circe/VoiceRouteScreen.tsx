import { useNavigation } from "@react-navigation/native";
import { Pressable, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { CirceOrb } from "../../components/circe-orb/CirceOrb";
import { useSystemReducedMotion, useVoiceOrbLevel } from "./useVoiceOrbLevel";

const MIDNIGHT = "#0F1620";
const INK = "#F6F2EF";
const MUTED = "#A9B0B8";

/**
 * Full-screen Listening experience (reference 05): immersive midnight,
 * Listening typography, the fiber field crossing the orb, Type instead and
 * Cancel actions. The orb is the same CirceOrb component as Home, in its dark
 * treatment, with the field enabled so the strands span the screen.
 */
export function VoiceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const reducedMotion = useSystemReducedMotion();
  const { level, phase, errorMessage } = useVoiceOrbLevel(true);

  return (
    <View className="flex-1" style={{ backgroundColor: MIDNIGHT, paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-5 py-3">
        <Text
          className="font-t3-bold text-foreground"
          style={{ color: MUTED, fontSize: 13, letterSpacing: 3 }}
        >
          CIRCE
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close voice"
          onPress={() => navigation.goBack()}
          className="h-11 w-11 items-center justify-center active:opacity-70"
        >
          <SymbolView name="xmark" size={20} tintColor={MUTED} type="monochrome" />
        </Pressable>
      </View>

      <View className="items-center gap-2 px-8 pt-4">
        <Text className="font-circe-serif text-center" style={{ color: INK, fontSize: 34 }}>
          {phase === "error" ? "Something held me back." : "Listening…"}
        </Text>
        <Text className="text-center text-base" style={{ color: MUTED }}>
          {phase === "error" && errorMessage !== null ? errorMessage : "Speak naturally. I'm here."}
        </Text>
      </View>

      <View className="flex-1 items-center justify-center">
        <CirceOrb
          state={phase}
          size={232}
          level={level}
          appearance="dark"
          width={width}
          reducedMotion={reducedMotion}
        />
      </View>

      <View
        className="flex-row items-center justify-center gap-3 px-8"
        style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Type instead"
          onPress={() => navigation.goBack()}
          className="min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full border active:opacity-70"
          style={{ borderColor: "#2D343E" }}
        >
          <SymbolView name={{ ios: "keyboard", android: "keyboard" }} size={18} tintColor={MUTED} />
          <Text className="text-sm font-t3-bold" style={{ color: INK }}>
            Type instead
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel voice"
          onPress={() => navigation.goBack()}
          className="min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full border active:opacity-70"
          style={{ borderColor: "#2D343E" }}
        >
          <SymbolView name="xmark" size={16} tintColor={MUTED} type="monochrome" />
          <Text className="text-sm font-t3-bold" style={{ color: INK }}>
            Cancel
          </Text>
        </Pressable>
      </View>
      <Text
        className="pb-2 text-center"
        style={{ color: MUTED, fontSize: 11, paddingBottom: Math.max(insets.bottom, 12) }}
      >
        Think · Take action · Get results
      </Text>
    </View>
  );
}
