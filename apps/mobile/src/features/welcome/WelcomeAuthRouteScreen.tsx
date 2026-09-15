import { AuthView } from "@clerk/expo/native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { StatusBar, View } from "react-native";

import { hasCloudPublicConfig } from "../cloud/publicConfig";

/**
 * Clerk-hosted sign-in for the welcome flow. Clerk owns the email UI and any
 * additional strategies; a completed sign-in activates the relay session and
 * the signed-out gate moves the user into the app plus mesh onboarding.
 */
export function WelcomeAuthRouteScreen() {
  const navigation = useNavigation();
  const handleHostBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.dispatch(StackActions.replace("Welcome"));
    }
  }, [navigation]);

  if (!hasCloudPublicConfig()) {
    return null;
  }

  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: "#FAF7F3" }}>
      <StatusBar barStyle="dark-content" />
      <AuthView isDismissible={false} onHostBack={handleHostBack} />
    </View>
  );
}
