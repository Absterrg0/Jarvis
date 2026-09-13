import {
  WS_METHODS,
  type CirceCancelRequestInput,
  type CirceExecuteInput,
  type CirceFocusTaskInput,
  type CirceInterpretInput,
  type CirceManageProjectAliasInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "@t3tools/client-runtime/rpc";

/** Send one text or transcribed voice instruction to the T3 Circe manager. */
export const executeCirceInstruction = Effect.fn("Circe.executeInstruction")(function* (
  input: CirceExecuteInput,
) {
  return yield* request(WS_METHODS.circeExecute, input);
});

/**
 * One semantic inference before irreversible routing. Runs the semantic
 * node's configured supervisor over the verbatim source plus untrusted mesh
 * evidence and returns a typed proposal with no dispatch. Pins stay on the
 * owner node; the proposal never authorizes on its own.
 */
export const interpretCirceInstruction = Effect.fn("Circe.interpretInstruction")(function* (
  input: CirceInterpretInput,
) {
  return yield* request(WS_METHODS.circeInterpret, input);
});

/**
 * Cancel one pre-accept request by its exact request identity. Cancelled
 * means nothing was dispatched; already-accepted means the work runs under
 * the returned identity; unknown means nothing cancellable is known.
 */
export const cancelCirceRequest = Effect.fn("Circe.cancelRequest")(function* (
  input: CirceCancelRequestInput,
) {
  return yield* request(WS_METHODS.circeCancelRequest, input);
});

/** Read the authenticated device's Host-owned task focus and bounded history. */
export const getCirceTaskDesk = Effect.fn("Circe.getTaskDesk")(function* () {
  return yield* request(WS_METHODS.circeGetTaskDesk, {});
});

/** Focus one exact recent task without exposing thread selection to a model. */
export const focusCirceTask = Effect.fn("Circe.focusTask")(function* (input: CirceFocusTaskInput) {
  return yield* request(WS_METHODS.circeFocusTask, input);
});

/** Read live canonical names and Host-learned project pronunciations. */
export const getCirceProjectVocabulary = Effect.fn("Circe.getProjectVocabulary")(function* () {
  return yield* request(WS_METHODS.circeGetProjectVocabulary, {});
});

export const manageCirceProjectAlias = Effect.fn("Circe.manageProjectAlias")(function* (
  input: CirceManageProjectAliasInput,
) {
  return yield* request(WS_METHODS.circeManageProjectAlias, input);
});
