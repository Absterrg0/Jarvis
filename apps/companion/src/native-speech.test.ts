// @effect-diagnostics nodeBuiltinImport:off - this narrow native-boundary test
// launches a disposable local recorder script to verify its actual streams.
import { assert, describe, it } from "@effect/vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWhisperCaptureState,
  createWhisperTranscriptBatchReader,
  createWhisperTranscriptReader,
  isWhisperCaptureReadyOutput,
  createLatestSpeechQueue,
  piperSynthesisArguments,
  piperVoicePaths,
  recognizeWithWhisper,
  speakNativeSpeech,
  whisperArguments,
  nativeAudioPlaybackTimeoutMs,
  whisperReleaseTailMs,
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

  it("does not complete a held capture until release and retains every spoken block", () => {
    const capture = createWhisperCaptureState();

    assert.equal(capture.recordTranscript("Please review the pull request"), false);
    assert.equal(capture.latestTranscript(), "Please review the pull request");

    capture.release();

    assert.equal(capture.recordTranscript("request in Rivvl"), true);
    assert.equal(capture.latestTranscript(), "Please review the pull request in Rivvl");
  });

  it("keeps a released capture open long enough for Whisper's final VAD block", () => {
    assert.isTrue(
      whisperReleaseTailMs >= 3_500,
      "A 1.5 second tail can terminate the recorder before its final transcript arrives.",
    );
  });

  it("keeps enough pre-roll and sensitivity to preserve an immediate first word", () => {
    assert.include(whisperArguments("model.bin").join(" "), "--keep 1000 -vth 0.5");
  });

  it("recognizes Whisper's actual microphone-ready signal", () => {
    assert.isTrue(isWhisperCaptureReadyOutput("[Start speaking]\n"));
    assert.isFalse(isWhisperCaptureReadyOutput("ggml_backend_load_all: loaded CPU backend\n"));
  });

  it("waits for microphone readiness and returns a VAD transcript from the native process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-whisper-ready-"));
    const executablePath = join(directory, "fake-whisper");
    await writeFile(
      executablePath,
      [
        "#!/bin/sh",
        "printf '[Start speaking]\\n'",
        "printf '### Transcription 0 START\\n'",
        "printf '[00:00]  Review the current implementation\\n'",
        "printf '### Transcription 0 END\\n'",
      ].join("\n"),
      "utf8",
    );
    await chmod(executablePath, 0o755);
    let ready = 0;
    try {
      const transcript = await recognizeWithWhisper({
        executablePath,
        modelPath: "unused",
        platform: "win32",
        onReady: () => {
          ready += 1;
        },
      });
      assert.equal(transcript, "Review the current implementation");
      assert.equal(ready, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Piper voice runtime", () => {
  it("allows ordinary spoken reports to finish instead of killing playback after five seconds", () => {
    assert.isAtLeast(nativeAudioPlaybackTimeoutMs, 120_000);
  });
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
      "--noise_scale",
      "0.667",
      "--length_scale",
      "1.03",
      "--noise_w",
      "0.8",
      "--sentence_silence",
      "0.28",
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
