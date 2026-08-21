// @effect-diagnostics nodeBuiltinImport:off - this regression test inspects the
// Companion command surfaces without importing Electron's main process.
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
const relayPreloadSource = readFileSync(new URL("./relay-preload.ts", import.meta.url), "utf8");

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
