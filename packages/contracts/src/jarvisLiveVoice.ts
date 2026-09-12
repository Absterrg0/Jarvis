import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/**
 * GPT-Live speech-to-speech session creation. The renderer owns microphone
 * and speaker media over WebRTC; the node owns the API key and mints the
 * session, so the key never crosses to a client.
 */
export const JARVIS_LIVE_VOICE_DEFAULT_MODEL = "gpt-live-1";
export const JARVIS_LIVE_VOICE_DEFAULT_VOICE = "marin";
export const JARVIS_LIVE_VOICE_MAX_SDP_LENGTH = 100_000;
export const JARVIS_LIVE_VOICE_MAX_CONTEXT_LENGTH = 2_000;

export const JarvisLiveVoiceCreateInput = Schema.Struct({
  /** Session Description Protocol offer from the renderer peer connection. */
  sdpOffer: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(JARVIS_LIVE_VOICE_MAX_SDP_LENGTH),
  ),
  /** Bounded app-authored context (focused project/task) for the live model. */
  context: Schema.optionalKey(
    TrimmedString.check(Schema.isMaxLength(JARVIS_LIVE_VOICE_MAX_CONTEXT_LENGTH)),
  ),
});
export type JarvisLiveVoiceCreateInput = typeof JarvisLiveVoiceCreateInput.Type;

export const JarvisLiveVoiceCreateResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  sdpAnswer: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(JARVIS_LIVE_VOICE_MAX_SDP_LENGTH),
  ),
  model: TrimmedNonEmptyString,
  voice: TrimmedNonEmptyString,
});
export type JarvisLiveVoiceCreateResult = typeof JarvisLiveVoiceCreateResult.Type;

export const JarvisLiveVoiceUnavailableReason = Schema.Literals([
  /** No API key is stored on this node. */
  "not-configured",
  /** This node's preset does not offer live voice. */
  "capability-unavailable",
]);
export type JarvisLiveVoiceUnavailableReason = typeof JarvisLiveVoiceUnavailableReason.Type;

export class JarvisLiveVoiceInvalidInputError extends Schema.TaggedError<JarvisLiveVoiceInvalidInputError>()(
  "JarvisLiveVoiceInvalidInputError",
  {
    message: Schema.String,
  },
) {}

export class JarvisLiveVoiceUnavailableError extends Schema.TaggedError<JarvisLiveVoiceUnavailableError>()(
  "JarvisLiveVoiceUnavailableError",
  {
    reason: JarvisLiveVoiceUnavailableReason,
    message: Schema.String,
  },
) {}

export class JarvisLiveVoiceRuntimeError extends Schema.TaggedError<JarvisLiveVoiceRuntimeError>()(
  "JarvisLiveVoiceRuntimeError",
  {
    message: Schema.String,
  },
) {}

export type JarvisLiveVoiceError =
  | JarvisLiveVoiceInvalidInputError
  | JarvisLiveVoiceUnavailableError
  | JarvisLiveVoiceRuntimeError;
