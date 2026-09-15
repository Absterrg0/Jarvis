import {
  WS_METHODS,
  type CirceLiveVoiceReleaseInput,
  type CirceLiveVoiceCreateInput,
  type CirceLiveVoiceRenewInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "@t3tools/client-runtime/rpc";

/**
 * Mint one GPT-Live WebRTC session on the node. The node owns the API key;
 * the renderer sends only its SDP offer and bounded app context, and receives
 * the SDP answer and opaque session id.
 */
export const startCirceVoiceLiveSession = Effect.fn("Circe.voiceLiveStart")(function* (
  input: CirceLiveVoiceCreateInput,
) {
  return yield* request(WS_METHODS.circeVoiceLiveStart, input);
});

export const releaseCirceVoiceLiveSession = Effect.fn("Circe.voiceLiveRelease")(function* (
  input: CirceLiveVoiceReleaseInput,
) {
  return yield* request(WS_METHODS.circeVoiceLiveRelease, input);
});

/**
 * Renew the server-side lease on one active session. The node closes any
 * session whose lease lapses, so a killed or sleeping renderer stops renewing
 * and the node ends the session without relying on a client timer.
 */
export const renewCirceVoiceLiveSession = Effect.fn("Circe.voiceLiveRenew")(function* (
  input: CirceLiveVoiceRenewInput,
) {
  return yield* request(WS_METHODS.circeVoiceLiveRenew, input);
});

export const lookupCirceQuickAnswer = Effect.fn("Circe.quickLookup")(function* (
  input: import("@t3tools/contracts").CirceQuickLookupInput,
) {
  return yield* request(WS_METHODS.circeQuickLookup, input);
});
