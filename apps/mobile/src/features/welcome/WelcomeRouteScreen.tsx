import { useOAuth } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StatusBar, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { CirceOrb } from "../../components/circe-orb/CirceOrb";
import { useSystemReducedMotion } from "../circe/useVoiceOrbLevel";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import {
  ArrowMark,
  CirceRingMark,
  EnvelopeMark,
  GoogleMark,
  ServerMark,
  ShieldMark,
} from "./welcomeMarks";

const IVORY = "#FAF7F3";
const INK = "#241D18";
const MUTED = "#8A7F78";
const FAINT = "#C9BFB6";
const COPPER = "#C97857";
const DARK_PILL = "#26262B";
const CARD = "#FFFFFF";

void WebBrowser.maybeCompleteAuthSession();

function useWarmUpBrowser(): void {
  useEffect(() => {
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

/**
 * Branded sign-in entry for Circe Mesh. Signed-out users land here so the
 * first thing they do is connect an account; sign-in activates the relay
 * session and the mesh onboarding sheet takes it from there. The surface is
 * fixed ivory per the brand reference, independent of system theme.
 */
export function WelcomeRouteScreen() {
  return (
    <>
      <StatusBar barStyle="dark-content" />
      <View style={{ flex: 1, backgroundColor: IVORY }}>
        {hasCloudPublicConfig() ? <ConfiguredWelcome /> : <UnconfiguredWelcome />}
      </View>
    </>
  );
}

function UnconfiguredWelcome() {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 24,
        paddingTop: insets.top + 24,
        paddingBottom: Math.max(insets.bottom, 24),
      }}
    >
      <CirceRingMark />
      <Text style={{ color: INK, fontSize: 22, fontWeight: "700" }}>Circe Mesh unavailable</Text>
      <Text style={{ color: MUTED, fontSize: 15, textAlign: "center", lineHeight: 22 }}>
        This build has no account service configured, so sign-in is turned off.
      </Text>
    </ScrollView>
  );
}

function ConfiguredWelcome() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const reducedMotion = useSystemReducedMotion();
  useWarmUpBrowser();
  const { startOAuthFlow } = useOAuth({ strategy: "oauth_google" });
  const [googleBusy, setGoogleBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const openEmailAuth = useCallback(() => {
    navigation.navigate("WelcomeAuth" as never);
  }, [navigation]);

  const continueWithGoogle = useCallback(() => {
    void (async () => {
      setGoogleBusy(true);
      setErrorMessage(null);
      try {
        const { createdSessionId, setActive } = await startOAuthFlow();
        if (createdSessionId && setActive) {
          await setActive({ session: createdSessionId });
        }
      } catch {
        setErrorMessage("Google sign-in didn't finish. Try again or use email.");
      } finally {
        setGoogleBusy(false);
      }
    })();
  }, [startOAuthFlow]);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        flexGrow: 1,
        paddingHorizontal: 28,
        paddingTop: insets.top + 20,
        paddingBottom: Math.max(insets.bottom, 20) + 8,
      }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 }}
      >
        <CirceRingMark size={26} />
        <Text style={{ color: INK, fontSize: 17, fontWeight: "700", letterSpacing: 5 }}>CIRCE</Text>
      </View>

      <Text
        className="font-circe-serif"
        style={{ color: INK, fontSize: 34, lineHeight: 40, textAlign: "center", marginTop: 18 }}
      >
        Direct work across every machine.
      </Text>
      <Text
        style={{ color: MUTED, fontSize: 15, lineHeight: 22, textAlign: "center", marginTop: 10 }}
      >
        Talk, plan and get things done across your projects and machines. Naturally.
      </Text>

      <View
        style={{
          marginHorizontal: -28,
          marginTop: 6,
          marginBottom: -24,
          alignItems: "center",
        }}
      >
        <CirceOrb
          state="idle"
          size={168}
          appearance="light"
          width={width}
          reducedMotion={reducedMotion}
        />
      </View>

      {errorMessage !== null ? (
        <Text style={{ color: "#B3402E", fontSize: 13, textAlign: "center", marginBottom: 8 }}>
          {errorMessage}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Continue with Google"
        onPress={continueWithGoogle}
        disabled={googleBusy}
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: DARK_PILL,
          borderRadius: 999,
          paddingVertical: 15,
          paddingHorizontal: 20,
          opacity: googleBusy ? 0.7 : 1,
        }}
      >
        <GoogleMark />
        <Text
          style={{
            flex: 1,
            color: "#FFFFFF",
            fontSize: 15,
            fontWeight: "600",
            textAlign: "center",
          }}
        >
          {googleBusy ? "Connecting…" : "Continue with Google"}
        </Text>
        <ArrowMark color="#FFFFFF" />
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Continue with email"
        onPress={openEmailAuth}
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: CARD,
          borderColor: "#E4DCD4",
          borderWidth: 1,
          borderRadius: 999,
          paddingVertical: 15,
          paddingHorizontal: 20,
          marginTop: 10,
        }}
      >
        <EnvelopeMark />
        <Text style={{ flex: 1, color: INK, fontSize: 15, fontWeight: "600", textAlign: "center" }}>
          Continue with email
        </Text>
        <ArrowMark />
      </Pressable>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 14 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: "#E7DFD6" }} />
        <Text style={{ color: FAINT, fontSize: 11, letterSpacing: 2 }}>OR</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: "#E7DFD6" }} />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="I already have an account"
        onPress={openEmailAuth}
      >
        <Text style={{ color: INK, fontSize: 14, fontWeight: "600", textAlign: "center" }}>
          I already have an account <Text style={{ color: COPPER }}>›</Text>
        </Text>
      </Pressable>

      <View style={{ flexDirection: "row", justifyContent: "center", gap: 26, marginTop: 22 }}>
        <View style={{ alignItems: "center", gap: 6, flex: 1 }}>
          <ShieldMark />
          <Text style={{ color: MUTED, fontSize: 11, textAlign: "center", lineHeight: 15 }}>
            Private by design
          </Text>
        </View>
        <View style={{ alignItems: "center", gap: 6, flex: 1 }}>
          <ServerMark />
          <Text style={{ color: MUTED, fontSize: 11, textAlign: "center", lineHeight: 15 }}>
            Across your machines
          </Text>
        </View>
        <View style={{ alignItems: "center", gap: 6, flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height: 20 }}>
            <View style={{ width: 3, height: 8, borderRadius: 2, backgroundColor: COPPER }} />
            <View style={{ width: 3, height: 14, borderRadius: 2, backgroundColor: COPPER }} />
            <View style={{ width: 3, height: 10, borderRadius: 2, backgroundColor: COPPER }} />
            <View style={{ width: 3, height: 14, borderRadius: 2, backgroundColor: COPPER }} />
            <View style={{ width: 3, height: 8, borderRadius: 2, backgroundColor: COPPER }} />
          </View>
          <Text style={{ color: MUTED, fontSize: 11, textAlign: "center", lineHeight: 15 }}>
            Voice + text
          </Text>
        </View>
      </View>

      <Text
        style={{ color: FAINT, fontSize: 10.5, lineHeight: 15, textAlign: "center", marginTop: 18 }}
      >
        By continuing, you agree to our Terms of Service and Privacy Policy.
      </Text>
    </ScrollView>
  );
}
