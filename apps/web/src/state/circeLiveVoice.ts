import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import {
  startCirceVoiceLiveSession,
  releaseCirceVoiceLiveSession,
} from "@circe/client-runtime/operations/circeLiveVoice";
import type { CirceLiveVoiceCreateInput, CirceLiveVoiceReleaseInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const circeLiveVoiceEnvironment = {
  release: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:voice-live-release",
    execute: (input: CirceLiveVoiceReleaseInput) => releaseCirceVoiceLiveSession(input),
  }),
  start: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:voice-live-start",
    execute: (input: CirceLiveVoiceCreateInput) => startCirceVoiceLiveSession(input),
  }),
};
