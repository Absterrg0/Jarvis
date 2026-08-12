import { assert, describe, it } from "@effect/vitest";

import { windowsSpeechCommand } from "./native-speech.ts";

describe("windowsSpeechCommand", () => {
  it("uses the default microphone and disposes the recognizer", () => {
    assert.include(windowsSpeechCommand, "SetInputToDefaultAudioDevice()");
    assert.include(windowsSpeechCommand, "DictationGrammar");
    assert.include(windowsSpeechCommand, "$recognizer.Dispose()");
  });
});
