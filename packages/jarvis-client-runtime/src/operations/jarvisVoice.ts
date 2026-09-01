import {
  WS_METHODS,
  type JarvisVoiceSynthesizeInput,
  type JarvisVoiceTranscribeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "@t3tools/client-runtime/rpc";

/** Transcribe one complete push-to-talk recording on the selected voice node. */
export const transcribeJarvisVoice = Effect.fn("JarvisVoice.transcribe")(function* (
  input: JarvisVoiceTranscribeInput,
) {
  return yield* request(WS_METHODS.jarvisVoiceTranscribe, input);
});

/** Synthesize one bounded Jarvis report on the selected voice node. */
export const synthesizeJarvisVoice = Effect.fn("JarvisVoice.synthesize")(function* (
  input: JarvisVoiceSynthesizeInput,
) {
  return yield* request(WS_METHODS.jarvisVoiceSynthesize, input);
});
