import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { startJarvisVoiceLiveSession } from "@t3tools/jarvis-client-runtime/operations/jarvisLiveVoice";
import type { JarvisLiveVoiceCreateInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const jarvisLiveVoiceEnvironment = {
  start: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:jarvis:voice-live-start",
    execute: (input: JarvisLiveVoiceCreateInput) => startJarvisVoiceLiveSession(input),
  }),
};
