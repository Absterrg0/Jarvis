import { executeJarvisInstruction } from "@t3tools/jarvis-client-runtime/operations/jarvis";
import {
  createEnvironmentCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import type { JarvisExecuteInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const jarvisEnvironment = {
  execute: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:jarvis:execute",
    execute: (input: JarvisExecuteInput) => executeJarvisInstruction(input),
  }),
  presentations: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "mobile:environment-data:jarvis:presentation-stream",
    tag: WS_METHODS.subscribeJarvisPresentation,
    idleTtlMs: 0,
  }),
};
