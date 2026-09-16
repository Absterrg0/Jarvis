import { useOAuth } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StatusBar,
  Text as RNText,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { CirceWelcomeHero } from "../../components/circe-welcome-hero/CirceWelcomeHero";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "../settings/lib/legal-document-url";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { ArrowMark, CirceMark, EnvelopeMark, GoogleMark } from "./welcomeMarks";

// Design system v1, light onboarding treatment. Warm ivory paper, near-black
// editorial ink, one burnt-copper phrase, and a near-black primary CTA whose
// brand cue is a restrained copper hairline and a faint copper cast in the fill.
const IVORY = "#FCF9F4";
const INK = "#151311";
const MUTED = "#707177";
const FAINT = "#918A84";
const COPPER_TEXT = "#A5482C";
const COPPER = "#E08A63";
// Warmer than a neutral near-black, so the pill reads as part of the copper
// palette rather than as generic dark chrome.
const CTA_FILL = "#1A1410";
const CTA_BORDER = "rgba(224, 138, 99, 0.44)";
const CARD = "#FFFDFA";
const CARD_BORDER = "rgba(56, 43, 35, 0.13)";
const RULE = "rgba(56, 43, 35, 0.12)";

/**
 * Applied explicitly to both headline spans rather than through a class.
 * `AppText` sets font-sans, and layering a serif class on top of it left the
 * pair fighting, with whichever won depending on render order.
 */
const DISPLAY_SERIF = "InstrumentSerif-Regular";

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
      <CirceMark />
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
  useWarmUpBrowser();
  const { startOAuthFlow } = useOAuth({ strategy: "oauth_google" });
  const [googleBusy, setGoogleBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const openEmailAuth = useCallback(() => {
    navigation.navigate("WelcomeAuth" as never);
  }, [navigation]);

  const openLegalDocument = useCallback((url: string) => {
    void WebBrowser.openBrowserAsync(url);
  }, []);

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
        paddingTop: insets.top + 12,
        paddingBottom: Math.max(insets.bottom, 20) + 8,
      }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 }}
      >
        <CirceMark height={30} />
        <Text style={{ color: INK, fontSize: 16, letterSpacing: 6 }}>CIRCE</Text>
      </View>

      {/* Hero sits directly under the wordmark and above the headline, as in the
          reference. It is full-bleed, so it cancels the screen's horizontal
          padding rather than being inset like the text. */}
      <View style={{ marginHorizontal: -28, marginTop: 12 }}>
        <CirceWelcomeHero width={width} />
      </View>

      {/* The break is explicit, and the first line is short enough to hold at
          this size. Left to wrap, a longer first line spills onto a third line
          and the block loses the reference's two-line balance. */}
      <RNText
        style={{
          fontFamily: DISPLAY_SERIF,
          color: INK,
          fontSize: 34,
          lineHeight: 40,
          textAlign: "center",
          marginTop: 12,
        }}
      >
        Talk to every machine,{"\n"}
        <RNText style={{ fontFamily: DISPLAY_SERIF, color: COPPER_TEXT }}>from anywhere.</RNText>
      </RNText>

      <Text
        style={{ color: MUTED, fontSize: 15, lineHeight: 22, textAlign: "center", marginTop: 8 }}
      >
        Talk, plan and get things done across your projects and machines. Naturally.
      </Text>

      {errorMessage !== null ? (
        <Text style={{ color: "#B3402E", fontSize: 13, textAlign: "center", marginTop: 10 }}>
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
          backgroundColor: CTA_FILL,
          borderColor: CTA_BORDER,
          borderWidth: 1,
          borderRadius: 999,
          paddingVertical: 15,
          paddingHorizontal: 20,
          marginTop: 24,
          opacity: googleBusy ? 0.7 : 1,
          // Copper cast rather than neutral chrome; iOS honours the tint, and
          // Android falls back to elevation depth.
          shadowColor: COPPER,
          shadowOpacity: 0.3,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: 3,
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
          borderColor: CARD_BORDER,
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
        <View style={{ flex: 1, height: 1, backgroundColor: RULE }} />
        <Text style={{ color: FAINT, fontSize: 11, letterSpacing: 2 }}>OR</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: RULE }} />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="I already have an account"
        onPress={openEmailAuth}
      >
        <Text
          style={{
            color: COPPER_TEXT,
            fontSize: 14,
            fontWeight: "600",
            textAlign: "center",
          }}
        >
          I already have an account ›
        </Text>
      </Pressable>

      <Text
        style={{ color: FAINT, fontSize: 10.5, lineHeight: 16, textAlign: "center", marginTop: 26 }}
      >
        By continuing, you agree to our{" "}
        <Text
          accessibilityRole="link"
          style={{ color: MUTED, textDecorationLine: "underline" }}
          onPress={() => openLegalDocument(TERMS_OF_SERVICE_URL)}
        >
          Terms of Service
        </Text>{" "}
        and{" "}
        <Text
          accessibilityRole="link"
          style={{ color: MUTED, textDecorationLine: "underline" }}
          onPress={() => openLegalDocument(PRIVACY_POLICY_URL)}
        >
          Privacy Policy
        </Text>
        .
      </Text>
    </ScrollView>
  );
}
