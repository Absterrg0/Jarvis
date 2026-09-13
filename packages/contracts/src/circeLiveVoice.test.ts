import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CIRCE_LIVE_VOICE_MAX_CONTEXT_LENGTH,
  CIRCE_LIVE_VOICE_MAX_SDP_LENGTH,
  CirceLiveVoiceCreateInput,
  CirceLiveVoiceCreateResult,
  CirceLiveVoiceUnavailableError,
} from "./circeLiveVoice.ts";

const decodeInput = Schema.decodeUnknownSync(CirceLiveVoiceCreateInput);
const decodeResult = Schema.decodeUnknownSync(CirceLiveVoiceCreateResult);
const isUnavailableError = Schema.is(CirceLiveVoiceUnavailableError);
const encodeUnavailableError = Schema.encodeSync(CirceLiveVoiceUnavailableError);

describe("Circe live voice contracts", () => {
  it("accepts an SDP offer with optional app context without trimming the SDP", () => {
    const sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n";
    expect(decodeInput({ sdpOffer: sdp })).toEqual({ sdpOffer: sdp });
    expect(decodeInput({ sdpOffer: sdp, context: " Focused project: circe. " })).toEqual({
      sdpOffer: sdp,
      context: "Focused project: circe.",
    });
  });

  it("rejects an empty or oversized offer and oversized context", () => {
    expect(() => decodeInput({ sdpOffer: "" })).toThrow();
    expect(() =>
      decodeInput({ sdpOffer: "A".repeat(CIRCE_LIVE_VOICE_MAX_SDP_LENGTH + 1) }),
    ).toThrow();
    expect(() =>
      decodeInput({
        sdpOffer: "v=0\r\n",
        context: "A".repeat(CIRCE_LIVE_VOICE_MAX_CONTEXT_LENGTH + 1),
      }),
    ).toThrow();
  });

  it("preserves the SDP answer line endings exactly", () => {
    const sdpAnswer = "v=0\r\ns=answer\r\n";
    expect(
      decodeResult({ sessionId: "live_1", sdpAnswer, model: "gpt-live-1", voice: "marin" }),
    ).toEqual({ sessionId: "live_1", sdpAnswer, model: "gpt-live-1", voice: "marin" });
  });

  it("carries a machine-readable unavailable reason", () => {
    const error = new CirceLiveVoiceUnavailableError({
      reason: "not-configured",
      message: "Add an OpenAI API key on this node to use live voice.",
    });
    expect(isUnavailableError(error)).toBe(true);
    expect(encodeUnavailableError(error)).toMatchObject({
      _tag: "CirceLiveVoiceUnavailableError",
      reason: "not-configured",
    });
  });
});
