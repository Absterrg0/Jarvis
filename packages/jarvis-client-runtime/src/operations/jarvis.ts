import {
  WS_METHODS,
  type JarvisCancelRequestInput,
  type JarvisExecuteInput,
  type JarvisFocusTaskInput,
  type JarvisInterpretInput,
  type JarvisManageProjectAliasInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "@t3tools/client-runtime/rpc";

/** Send one text or transcribed voice instruction to the T3 Jarvis manager. */
export const executeJarvisInstruction = Effect.fn("Jarvis.executeInstruction")(function* (
  input: JarvisExecuteInput,
) {
  return yield* request(WS_METHODS.jarvisExecute, input);
});

/**
 * One semantic inference before irreversible routing. Runs the semantic
 * node's configured supervisor over the verbatim source plus untrusted mesh
 * evidence and returns a typed proposal with no dispatch. Pins stay on the
 * owner node; the proposal never authorizes on its own.
 */
export const interpretJarvisInstruction = Effect.fn("Jarvis.interpretInstruction")(function* (
  input: JarvisInterpretInput,
) {
  return yield* request(WS_METHODS.jarvisInterpret, input);
});

/**
 * Cancel one pre-accept request by its exact request identity. Cancelled
 * means nothing was dispatched; already-accepted means the work runs under
 * the returned identity; unknown means nothing cancellable is known.
 */
export const cancelJarvisRequest = Effect.fn("Jarvis.cancelRequest")(function* (
  input: JarvisCancelRequestInput,
) {
  return yield* request(WS_METHODS.jarvisCancelRequest, input);
});

/** Read the authenticated device's Host-owned task focus and bounded history. */
export const getJarvisTaskDesk = Effect.fn("Jarvis.getTaskDesk")(function* () {
  return yield* request(WS_METHODS.jarvisGetTaskDesk, {});
});

/** Focus one exact recent task without exposing thread selection to a model. */
export const focusJarvisTask = Effect.fn("Jarvis.focusTask")(function* (
  input: JarvisFocusTaskInput,
) {
  return yield* request(WS_METHODS.jarvisFocusTask, input);
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
