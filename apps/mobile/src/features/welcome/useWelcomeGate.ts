import { useAuth } from "@clerk/expo";
import { StackActions, useNavigation, type NavigationState } from "@react-navigation/native";
import { useEffect, useState } from "react";

/** Routes the gate leaves alone, so onboarding and dev tooling stay reachable. */
const GATE_EXEMPT_ROUTES: ReadonlySet<string> = new Set(["Welcome", "WelcomeAuth", "OrbGallery"]);

/**
 * How long to wait for Clerk before assuming there is no session.
 *
 * Without this, a device that cannot reach Clerk's servers never reports
 * `isLoaded`, the gate returns early forever, and a signed-out user is dropped
 * straight into the app with no way to connect through Circe Mesh. Treating a
 * stalled load as signed out is the safer failure: Welcome can always sign the
 * user back in, and a genuinely stored session resolves from the token cache
 * without the network.
 */
const CLERK_LOAD_TIMEOUT_MS = 3000;

/**
 * Signed-out gate for Circe Mesh onboarding.
 *
 * When the account service is configured and there is no usable session, any
 * route outside the welcome flow is replaced with Welcome, so connecting
 * through the mesh is the front door rather than an option buried in settings.
 * Signed-in users who land on Welcome are sent into the app. Without cloud
 * config the gate is never mounted and navigation behaves exactly as before.
 */
export function WelcomeGate({ state }: { readonly state: NavigationState }) {
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (isLoaded) {
      setTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), CLERK_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isLoaded]);

  const resolved = isLoaded || timedOut;
  const signedIn = isLoaded && isSignedIn === true;
  const exempt = GATE_EXEMPT_ROUTES.has(state.routes[state.index]?.name ?? "");

  useEffect(() => {
    if (!resolved) return;
    if (!signedIn && !exempt) {
      navigation.dispatch(StackActions.replace("Welcome"));
    } else if (signedIn && exempt) {
      navigation.dispatch(StackActions.replace("Circe"));
    }
  }, [exempt, navigation, resolved, signedIn]);

  return null;
}
