import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type CircePushRegistrationInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const circePushEnvironment = {
  register: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:circe:register-push-token",
    tag: WS_METHODS.circeRegisterPushToken,
  }),
};

export type { CircePushRegistrationInput };
