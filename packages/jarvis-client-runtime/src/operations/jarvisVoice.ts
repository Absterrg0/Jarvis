import type { JarvisVoiceAudioChunk } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { JarvisVoiceRuntimeError } from "@t3tools/contracts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
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

/** A finite speech stream uses the current session once; reconnect must not replay speech. */
export const streamJarvisVoice = Effect.fn("JarvisVoice.stream")(function* (
  input: JarvisVoiceSynthesizeInput,
  onAudio: (chunk: JarvisVoiceAudioChunk) => Promise<void>,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session))
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: "The selected voice node disconnected.",
    });
  return yield* session.value.client[WS_METHODS.jarvisVoiceStream](input).pipe(
    Stream.runForEach((chunk) =>
      Effect.tryPromise({
        try: () => onAudio(chunk),
        catch: (cause) =>
          new JarvisVoiceRuntimeError({
            operation: "synthesize",
            message: cause instanceof Error ? cause.message : "Mobile audio playback failed.",
          }),
      }),
    ),
  );
});
