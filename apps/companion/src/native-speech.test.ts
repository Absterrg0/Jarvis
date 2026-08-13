import { assert, describe, it } from "@effect/vitest";

import {
  createWhisperCaptureState,
  createWhisperTranscriptBatchReader,
  createWhisperTranscriptReader,
  createLatestSpeechQueue,
  piperSynthesisArguments,
  piperVoicePaths,
  speakNativeSpeech,
  windowsSpeechCommand,
} from "./native-speech.ts";

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

  it("retains every completed VAD block while the mic remains open", () => {
    const reader = createWhisperTranscriptBatchReader();

    assert.deepEqual(
      reader.push(
        "### Transcription 0 START\n[00:00]  First thought\n### Transcription 0 END\n### Transcription 1 START\n[00:01]  Final instruction\n### Transcription 1 END\n",
      ),
      ["First thought", "Final instruction"],
    );
  });

  it("does not complete a held capture until release, then prefers the final VAD block", () => {
    const capture = createWhisperCaptureState();

    assert.equal(capture.recordTranscript("First thought"), false);
    assert.equal(capture.latestTranscript(), "First thought");

    capture.release();

    assert.equal(capture.recordTranscript("Final instruction"), true);
    assert.equal(capture.latestTranscript(), "Final instruction");
  });
});

describe("Piper voice runtime", () => {
  it("uses the requested local US English hfc_female voice", () => {
    assert.deepEqual(piperVoicePaths("/jarvis/piper"), {
      executablePath: "/jarvis/piper/runtime/piper.exe",
      modelPath: "/jarvis/piper/voice/en_US-hfc_female-medium.onnx",
      configPath: "/jarvis/piper/voice/en_US-hfc_female-medium.onnx.json",
    });
  });

  it("passes the model and matching config directly to Piper", () => {
    const paths = piperVoicePaths("/jarvis/piper");

    assert.deepEqual(piperSynthesisArguments(paths, "/tmp/jarvis.wav"), [
      "--model",
      paths.modelPath,
      "--config",
      paths.configPath,
      "--output_file",
      "/tmp/jarvis.wav",
      "--sentence_silence",
      "0.12",
      "--quiet",
    ]);
  });

  it("keeps native Piper synthesis Windows-only", async () => {
    await speakNativeSpeech("This must not launch Piper on this platform.", "linux");
  });

  it("keeps only the latest pending report while a sentence is speaking", async () => {
    const spoken: Array<string> = [];
    const complete: Array<() => void> = [];
    const queue = createLatestSpeechQueue(
      (text) =>
        new Promise<void>((resolve) => {
          spoken.push(text);
          complete.push(resolve);
        }),
    );

    const first = queue("First report");
    const stale = queue("Stale report");
    const latest = queue("Latest report");

    assert.deepEqual(spoken, ["First report"]);
    complete.shift()?.();
    await first;
    await stale;
    assert.deepEqual(spoken, ["First report", "Latest report"]);

    complete.shift()?.();
    await latest;
  });
});
