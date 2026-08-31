import {
  WS_METHODS,
  type JarvisExecuteInput,
  type JarvisFocusTaskInput,
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
