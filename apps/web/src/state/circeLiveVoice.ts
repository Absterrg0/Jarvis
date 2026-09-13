import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { startCirceVoiceLiveSession } from "@circe/client-runtime/operations/circeLiveVoice";
import type { CirceLiveVoiceCreateInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const circeLiveVoiceEnvironment = {
  start: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:voice-live-start",
    execute: (input: CirceLiveVoiceCreateInput) => startCirceVoiceLiveSession(input),
  }),
};
