import {
  claimJarvisSpeaker,
  confirmJarvisReportSpoken,
  acknowledgeJarvisVoiceReport,
  executeJarvisInstruction,
  releaseJarvisReportSpeech,
} from "@t3tools/jarvis-client-runtime/operations/jarvis";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import type {
  JarvisAcknowledgeVoiceReportInput,
  JarvisExecuteInput,
  JarvisSpeakerClaimInput,
  JarvisSpeechConfirmationInput,
  JarvisSpeechReleaseInput,
} from "@t3tools/contracts";

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
  reportInbox: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:jarvis:report-inbox",
    tag: WS_METHODS.subscribeJarvisReportInbox,
    idleTtlMs: 5_000,
  }),
  claimSpeaker: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:jarvis:claim-speaker",
    execute: (input: JarvisSpeakerClaimInput) => claimJarvisSpeaker(input),
  }),
  confirmReportSpoken: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:jarvis:confirm-report-spoken",
    execute: (input: JarvisSpeechConfirmationInput) => confirmJarvisReportSpoken(input),
  }),
  releaseReportSpeech: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:jarvis:release-report-speech",
    execute: (input: JarvisSpeechReleaseInput) => releaseJarvisReportSpeech(input),
  }),
  acknowledgeReport: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:jarvis:acknowledge-report",
    execute: (input: JarvisAcknowledgeVoiceReportInput) => acknowledgeJarvisVoiceReport(input),
  }),
};
