import {
  WS_METHODS,
  type JarvisExecuteInput,
  type JarvisTaskDeskNavigation,
  type JarvisSpeakerClaimInput,
  type JarvisSpeechConfirmationInput,
  type JarvisSpeechReleaseInput,
  type JarvisManageProjectAliasInput,
  type JarvisAcknowledgeVoiceReportInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "@t3tools/client-runtime/rpc";

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

export const confirmJarvisReportSpoken = Effect.fn("Jarvis.confirmReportSpoken")(function* (
  input: JarvisSpeechConfirmationInput,
) {
  return yield* request(WS_METHODS.jarvisConfirmReportSpoken, input);
});

export const releaseJarvisReportSpeech = Effect.fn("Jarvis.releaseReportSpeech")(function* (
  input: JarvisSpeechReleaseInput,
) {
  return yield* request(WS_METHODS.jarvisReleaseReportSpeech, input);
});

export const acknowledgeJarvisVoiceReport = Effect.fn("Jarvis.acknowledgeVoiceReport")(function* (
  input: JarvisAcknowledgeVoiceReportInput,
) {
  return yield* request(WS_METHODS.jarvisAcknowledgeReport, input);
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

/** Read live canonical names and Host-learned project pronunciations. */
export const getJarvisProjectVocabulary = Effect.fn("Jarvis.getProjectVocabulary")(function* () {
  return yield* request(WS_METHODS.jarvisGetProjectVocabulary, {});
});

export const manageJarvisProjectAlias = Effect.fn("Jarvis.manageProjectAlias")(function* (
  input: JarvisManageProjectAliasInput,
) {
  return yield* request(WS_METHODS.jarvisManageProjectAlias, input);
});
