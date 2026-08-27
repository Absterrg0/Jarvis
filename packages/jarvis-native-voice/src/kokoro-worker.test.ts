// @effect-diagnostics nodeBuiltinImport:off - this regression test inspects
// the disposable worker and standalone smoke configuration without importing
// Electron or starting the native speech runtime.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const workerSource = NodeFS.readFileSync(new URL("./kokoro-worker.ts", import.meta.url), "utf8");
const smokeSource = NodeFS.readFileSync(
  new URL("../scripts/smoke-speech-runtime.mjs", import.meta.url),
  "utf8",
);

describe("Kokoro Electron buffer compatibility", () => {
  it("keeps production synthesis in V8-owned buffers", () => {
    assert.include(workerSource, "enableExternalBuffer: false");
    assert.notInclude(workerSource, "enableExternalBuffer: true");
  });

  it("streams native progress chunks without writing a duplicate full-response WAV", () => {
    assert.include(workerSource, "onProgress:");
    assert.include(workerSource, 'type: "chunk"');
    assert.include(workerSource, 'type: "synthesis-finished"');
    assert.notInclude(workerSource, "request.outputPath");
  });

  it("uses conversational pacing and pads every playable chunk", () => {
    assert.include(workerSource, "speed: 0.97");
    assert.include(workerSource, "silenceScale: 0.42");
    assert.include(workerSource, "appendSpeechTrailingSilence(samples, sampleRate)");
    assert.include(workerSource, "appendSpeechTrailingSilence(audio.samples, audio.sampleRate)");
  });

  it("keeps the profiled two-thread default", () => {
    assert.include(workerSource, 'JARVIS_KOKORO_NUM_THREADS ?? "2"');
    assert.include(workerSource, "numThreads,");
  });

  it("keeps standalone runtime smoke aligned with production", () => {
    assert.include(smokeSource, "enableExternalBuffer: false");
    assert.notInclude(smokeSource, "enableExternalBuffer: true");
  });
});
