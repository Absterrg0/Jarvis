import { WS_METHODS, type JarvisLiveVoiceCreateInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "@t3tools/client-runtime/rpc";

/**
 * Mint one GPT-Live WebRTC session on the node. The node owns the API key;
 * the renderer sends only its SDP offer and bounded app context, and receives
 * the SDP answer and opaque session id.
 */
export const startJarvisVoiceLiveSession = Effect.fn("Jarvis.voiceLiveStart")(function* (
  input: JarvisLiveVoiceCreateInput,
) {
  return yield* request(WS_METHODS.jarvisVoiceLiveStart, input);
});
