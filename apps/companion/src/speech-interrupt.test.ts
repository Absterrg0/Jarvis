// @effect-diagnostics nodeBuiltinImport:off - this regression test inspects the
// Companion command surfaces without importing Electron's main process.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const mainSource = NodeFS.readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = NodeFS.readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
const relayPreloadSource = NodeFS.readFileSync(
  new URL("./relay-preload.ts", import.meta.url),
  "utf8",
);
const reporterSource = NodeFS.readFileSync(
  new URL("../../web/src/components/jarvis/JarvisVoiceReporter.tsx", import.meta.url),
  "utf8",
);

describe("companion speech interruption wiring", () => {
  it("exposes interruption on the voice surface and tray, not the report relay", () => {
    assert.include(
      preloadSource,
      'interruptSpeech: () => ipcRenderer.invoke("jarvis-companion:interrupt-speech")',
    );
    assert.include(mainSource, "ipcMain.handle(INTERRUPT_SPEECH_CHANNEL");
    assert.include(mainSource, 'interruptCompanionSpeech("overlay")');
    assert.include(mainSource, 'interruptCompanionSpeech("capture")');
    assert.include(mainSource, 'label: "Stop speaking"');
    assert.include(mainSource, "enabled: isNativeSpeechActive()");
    assert.notInclude(relayPreloadSource, "interruptSpeech");
    assert.notInclude(relayPreloadSource, "interrupt-speech");
  });

  it("warms Kokoro only after this device wins the Host speaker claim", () => {
    assert.include(relayPreloadSource, "jarvis-companion:prepare-speech");
    const claim = reporterSource.indexOf("let claim = await claimReport()");
    const granted = reporterSource.indexOf("claim.granted &&", claim);
    const seen = reporterSource.indexOf("readSeenReports().has(reportKey)", granted);
    const prepare = reporterSource.indexOf("prepareSpeech?.()", granted);
    const speak = reporterSource.indexOf("speakReport(environmentId, report", prepare);
    assert.isAtLeast(claim, 0);
    assert.isAbove(granted, claim);
    assert.isAbove(seen, granted);
    assert.isAbove(prepare, seen);
    assert.isAbove(speak, prepare);
  });

  it("loads both native models from the packaged artifact before release", () => {
    assert.include(mainSource, 'process.argv.includes("--speech-smoke")');
    assert.include(mainSource, "prepareParakeetRecognition(parakeetPaths().paths)");
    assert.include(mainSource, "prepareNativeSpeech()");
  });

  it("keeps Host report acknowledgement independent of stopping speech", () => {
    assert.include(mainSource, "await speakCompanionSpeech(text.trim());");
    assert.include(mainSource, "interruptNativeSpeech()");
    assert.notInclude(
      mainSource,
      "acknowledgeReport",
      "Companion interruption must not acknowledge Host reports itself.",
    );
    assert.include(
      mainSource,
      'kind: "interrupted"',
      "An explicit stop may change the overlay without touching report ack.",
    );
  });
});
