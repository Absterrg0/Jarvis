import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/**
 * GPT-Live speech-to-speech session creation. The renderer owns microphone
 * and speaker media over WebRTC; the node owns the API key and mints the
 * session, so the key never crosses to a client.
 */
export const CIRCE_LIVE_VOICE_DEFAULT_MODEL = "gpt-live-1";
export const CIRCE_LIVE_VOICE_DEFAULT_VOICE = "marin";
export const CIRCE_LIVE_VOICE_MAX_SDP_LENGTH = 100_000;
export const CIRCE_LIVE_VOICE_MAX_CONTEXT_LENGTH = 2_000;

export const CirceLiveVoiceCreateInput = Schema.Struct({
  /** Session Description Protocol offer from the renderer peer connection. */
  sdpOffer: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CIRCE_LIVE_VOICE_MAX_SDP_LENGTH),
  ),
  /** Bounded app-authored context (focused project/task) for the live model. */
  context: Schema.optionalKey(
    TrimmedString.check(Schema.isMaxLength(CIRCE_LIVE_VOICE_MAX_CONTEXT_LENGTH)),
  ),
});
export type CirceLiveVoiceCreateInput = typeof CirceLiveVoiceCreateInput.Type;

export const CirceLiveVoiceReleaseInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type CirceLiveVoiceReleaseInput = typeof CirceLiveVoiceReleaseInput.Type;

export const CirceLiveVoiceCreateResult = Schema.Struct({
  /** Cloud sessions must be closed through the node to free their relay reservation. */
  releaseRequired: Schema.optionalKey(Schema.Boolean),
  sessionId: TrimmedNonEmptyString,
  sdpAnswer: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CIRCE_LIVE_VOICE_MAX_SDP_LENGTH),
  ),
  model: TrimmedNonEmptyString,
  voice: TrimmedNonEmptyString,
});
export type CirceLiveVoiceCreateResult = typeof CirceLiveVoiceCreateResult.Type;

export const CirceLiveVoiceUnavailableReason = Schema.Literals([
  /** No API key is stored on this node. */
  "not-configured",
  /** This node's preset does not offer live voice. */
  "capability-unavailable",
]);
export type CirceLiveVoiceUnavailableReason = typeof CirceLiveVoiceUnavailableReason.Type;

export class CirceLiveVoiceInvalidInputError extends Schema.TaggedError<CirceLiveVoiceInvalidInputError>()(
  "CirceLiveVoiceInvalidInputError",
  {
    message: Schema.String,
  },
) {}

export class CirceLiveVoiceUnavailableError extends Schema.TaggedError<CirceLiveVoiceUnavailableError>()(
  "CirceLiveVoiceUnavailableError",
  {
    reason: CirceLiveVoiceUnavailableReason,
    message: Schema.String,
  },
) {}

export class CirceLiveVoiceRuntimeError extends Schema.TaggedError<CirceLiveVoiceRuntimeError>()(
  "CirceLiveVoiceRuntimeError",
  {
    message: Schema.String,
  },
) {}

export type CirceLiveVoiceError =
  | CirceLiveVoiceInvalidInputError
  | CirceLiveVoiceUnavailableError
  | CirceLiveVoiceRuntimeError;
