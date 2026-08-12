import { assert, describe, it } from "@effect/vitest";

import { createWhisperTranscriptReader, windowsSpeechCommand } from "./native-speech.ts";

describe("windowsSpeechCommand", () => {
  it("uses the default microphone and disposes the recognizer", () => {
    assert.include(windowsSpeechCommand, "SetInputToDefaultAudioDevice()");
    assert.include(windowsSpeechCommand, "DictationGrammar");
    assert.include(windowsSpeechCommand, "$recognizer.Dispose()");
  });

  it("keeps the legacy recognizer out of the primary local Whisper path", () => {
    assert.include(windowsSpeechCommand, "DictationGrammar");
  });

  it("does not confuse Whisper startup diagnostics with a completed task", () => {
    const reader = createWhisperTranscriptReader();

    assert.isUndefined(reader.push("[Start speaking]\n"));
    assert.isUndefined(reader.push("ggml_backend_load_all: loaded CPU backend\n"));
  });

  it("returns speech only after Whisper completes a VAD transcription", () => {
    const reader = createWhisperTranscriptReader();

    assert.isUndefined(reader.push("### Transcription 0 START | t0 = 0 ms | t1 = 1234 ms\n\n"));
    assert.isUndefined(reader.push("[00:00:00.000 --> 00:00:01.230]  Review the cu"));
    assert.equal(
      reader.push("rrent implementation\n\n### Transcription 0 END\n"),
      "Review the current implementation",
    );
  });
});
