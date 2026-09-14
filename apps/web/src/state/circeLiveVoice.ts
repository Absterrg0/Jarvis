import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import {
  lookupCirceQuickAnswer,
  startCirceVoiceLiveSession,
  releaseCirceVoiceLiveSession,
} from "@circe/client-runtime/operations/circeLiveVoice";
import type { CirceLiveVoiceCreateInput, CirceLiveVoiceReleaseInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const circeLiveVoiceEnvironment = {
  lookup: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:quick-lookup",
    execute: (input: import("@t3tools/contracts").CirceQuickLookupInput) =>
      lookupCirceQuickAnswer(input),
  }),
  release: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:voice-live-release",
    execute: (input: CirceLiveVoiceReleaseInput) => releaseCirceVoiceLiveSession(input),
  }),
  start: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:voice-live-start",
    execute: (input: CirceLiveVoiceCreateInput) => startCirceVoiceLiveSession(input),
  }),
};
