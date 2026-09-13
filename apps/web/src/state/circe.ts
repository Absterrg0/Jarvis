import { executeCirceInstruction } from "@circe/client-runtime/operations/circe";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import type { CirceExecuteInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const circeEnvironment = {
  execute: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:execute",
    execute: (input: CirceExecuteInput) => executeCirceInstruction(input),
  }),
  presentations: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:circe:presentation-stream",
    tag: WS_METHODS.subscribeCircePresentation,
    // Presentation is live-only. Drop the atom immediately when the
    // Controller unmounts so an old terminal frame cannot be spoken after a
    // later remount.
    idleTtlMs: 0,
  }),
};
