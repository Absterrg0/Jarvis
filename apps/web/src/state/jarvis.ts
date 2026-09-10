import { executeJarvisInstruction } from "@t3tools/jarvis-client-runtime/operations/jarvis";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import type { JarvisExecuteInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const jarvisEnvironment = {
  execute: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:jarvis:execute",
    execute: (input: JarvisExecuteInput) => executeJarvisInstruction(input),
  }),
  presentations: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:jarvis:presentation-stream",
    tag: WS_METHODS.subscribeJarvisPresentation,
    // Presentation is live-only. Drop the atom immediately when the
    // Controller unmounts so an old terminal frame cannot be spoken after a
    // later remount.
    idleTtlMs: 0,
  }),
};
