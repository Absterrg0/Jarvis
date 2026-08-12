import {
  claimJarvisSpeaker,
  executeJarvisInstruction,
} from "@t3tools/client-runtime/operations/jarvis";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import type { JarvisExecuteInput, JarvisSpeakerClaimInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const jarvisEnvironment = {
  execute: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:jarvis:execute",
    execute: (input: JarvisExecuteInput) => executeJarvisInstruction(input),
  }),
  reports: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:jarvis:reports",
    tag: WS_METHODS.subscribeJarvisReports,
    idleTtlMs: 5_000,
  }),
  claimSpeaker: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:jarvis:claim-speaker",
    execute: (input: JarvisSpeakerClaimInput) => claimJarvisSpeaker(input),
  }),
};
