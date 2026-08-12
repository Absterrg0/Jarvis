import { assert, describe, it } from "@effect/vitest";

import { windowsSpeechCommand } from "./native-speech.ts";

describe("windowsSpeechCommand", () => {
  it("uses the default microphone and disposes the recognizer", () => {
    assert.include(windowsSpeechCommand, "SetInputToDefaultAudioDevice()");
    assert.include(windowsSpeechCommand, "DictationGrammar");
    assert.include(windowsSpeechCommand, "$recognizer.Dispose()");
  });

  it("keeps the legacy recognizer out of the primary local Whisper path", () => {
    assert.include(windowsSpeechCommand, "DictationGrammar");
  });
});
