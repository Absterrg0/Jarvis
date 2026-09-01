import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  JARVIS_VOICE_MAX_SYNTHESIS_PCM_BASE64_LENGTH,
  JarvisVoiceSynthesizeInput,
  JarvisVoiceTranscribeInput,
} from "./jarvisVoice.ts";

const BoundedBase64 = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  Schema.isMaxLength(JARVIS_VOICE_MAX_SYNTHESIS_PCM_BASE64_LENGTH),
);

const RequestBase = {
  requestId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
};

export const DesktopVoiceBrokerRequest = Schema.Union([
  Schema.Struct({
    ...RequestBase,
    operation: Schema.Literal("transcribe"),
    input: JarvisVoiceTranscribeInput,
  }),
  Schema.Struct({
    ...RequestBase,
    operation: Schema.Literal("synthesize"),
    input: JarvisVoiceSynthesizeInput,
  }),
]);
export type DesktopVoiceBrokerRequest = typeof DesktopVoiceBrokerRequest.Type;

export const DesktopVoiceBrokerResponse = Schema.Union([
  Schema.Struct({
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(true),
    operation: Schema.Literal("transcribe"),
    text: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(true),
    operation: Schema.Literal("synthesize"),
    sampleRate: PositiveInt,
    channels: Schema.Literal(1),
    pcmBase64: BoundedBase64,
  }),
  Schema.Struct({
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(false),
    message: TrimmedNonEmptyString,
  }),
]);
export type DesktopVoiceBrokerResponse = typeof DesktopVoiceBrokerResponse.Type;
