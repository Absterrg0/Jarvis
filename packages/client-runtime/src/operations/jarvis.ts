import {
  WS_METHODS,
  type JarvisExecuteInput,
  type JarvisTaskDeskNavigation,
  type JarvisSpeakerClaimInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";

/** Send one text or transcribed voice instruction to the T3 Jarvis manager. */
export const executeJarvisInstruction = Effect.fn("Jarvis.executeInstruction")(function* (
  input: JarvisExecuteInput,
) {
  return yield* request(WS_METHODS.jarvisExecute, input);
});

export const claimJarvisSpeaker = Effect.fn("Jarvis.claimSpeaker")(function* (
  input: JarvisSpeakerClaimInput,
) {
  return yield* request(WS_METHODS.jarvisClaimSpeaker, input);
});

/** Read the authenticated device's Host-owned task focus and bounded history. */
export const getJarvisTaskDesk = Effect.fn("Jarvis.getTaskDesk")(function* () {
  return yield* request(WS_METHODS.jarvisGetTaskDesk, {});
});

/** Apply deterministic navigation without exposing thread selection to a model. */
export const navigateJarvisTaskDesk = Effect.fn("Jarvis.navigateTaskDesk")(function* (
  navigation: JarvisTaskDeskNavigation,
) {
  return yield* request(WS_METHODS.jarvisNavigateTaskDesk, navigation);
});
