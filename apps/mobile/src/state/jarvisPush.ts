import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type JarvisPushRegistrationInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const jarvisPushEnvironment = {
  register: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:jarvis:register-push-token",
    tag: WS_METHODS.jarvisRegisterPushToken,
  }),
};

export type { JarvisPushRegistrationInput };
