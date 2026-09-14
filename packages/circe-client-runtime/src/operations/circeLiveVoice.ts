import {
  WS_METHODS,
  type CirceLiveVoiceReleaseInput,
  type CirceLiveVoiceCreateInput,
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
