// @effect-diagnostics nodeBuiltinImport:off - this regression test inspects the
// Companion command surfaces without importing Electron's main process.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const mainSource = NodeFS.readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const packageSource = NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8");
const releaseWorkflowSource = NodeFS.readFileSync(
  new URL("../../../.github/workflows/jarvis-companion-release.yml", import.meta.url),
  "utf8",
);
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

  it("warms Kokoro before a captured voice task can start", () => {
    const dispatchStart = mainSource.indexOf("async function dispatchCapturedTranscript");
    const dispatchEnd = mainSource.indexOf("async function startHeldCapture", dispatchStart);
    const dispatch = mainSource.slice(dispatchStart, dispatchEnd);
    const prepare = dispatch.indexOf("prepareNativeSpeech()");
    const ready = dispatch.indexOf("Promise.race([speechReady", prepare);
    const submit = dispatch.indexOf("submitTranscriptToHost");

    assert.isAtLeast(dispatchStart, 0);
    assert.isAtLeast(prepare, 0);
    assert.isAbove(ready, prepare);
    assert.isAbove(submit, ready);
  });

  it("starts warming Kokoro while the user is still speaking", () => {
    const captureStart = mainSource.indexOf("async function startHeldCapture");
    const captureEnd = mainSource.indexOf("function releaseHeldCapture", captureStart);
    const capture = mainSource.slice(captureStart, captureEnd);
    const prepare = capture.indexOf("prepareNativeSpeech()");
    const microphone = capture.indexOf("startParakeetCapture");

    assert.isAtLeast(prepare, 0);
    assert.isAbove(microphone, prepare);
  });

  it("reserves acknowledgement speech before submitting to Jarvis Host", () => {
    const submitStart = mainSource.indexOf("async function submitTranscriptToHost");
    const submitEnd = mainSource.indexOf("async function readSetup", submitStart);
    const submit = mainSource.slice(submitStart, submitEnd);
    const reserve = submit.indexOf("reserveNativeSpeech()");
    const host = submit.indexOf("submitCompanionTask");
    const commit = submit.indexOf(".commit(", host);
    const clearPending = submit.indexOf('if (result.kind !== "error")', host);

    assert.isAtLeast(reserve, 0);
    assert.isAbove(host, reserve);
    assert.isAbove(commit, host);
    assert.isAbove(clearPending, commit);
  });

  it("skips a stale acknowledgement when Kokoro is still cold after Host acceptance", () => {
    const dispatchStart = mainSource.indexOf("async function dispatchCapturedTranscript");
    const dispatchEnd = mainSource.indexOf("async function startHeldCapture", dispatchStart);
    const dispatch = mainSource.slice(dispatchStart, dispatchEnd);
    const submitStart = mainSource.indexOf("async function submitTranscriptToHost");
    const submitEnd = mainSource.indexOf("async function readSetup", submitStart);
    const submit = mainSource.slice(submitStart, submitEnd);

    assert.include(dispatch, "isNativeSpeechReady");
    assert.notInclude(dispatch, "let acknowledgementReady");
    assert.include(submit, "acknowledgementReady: () => boolean = isNativeSpeechReady");
    assert.include(submit, "acknowledgementReady()");
  });

  it("loads both native models from the packaged artifact before release", () => {
    assert.include(mainSource, 'process.argv.includes("--speech-smoke")');
    assert.include(mainSource, "prepareNativeMicrophone");
    assert.include(mainSource, "prepareParakeetRecognition(parakeetPaths().paths)");
    assert.include(mainSource, "prepareNativeSpeech()");
    assert.include(
      packageSource,
      '"sherpa-onnx-win-x64": "1.13.6"',
      "Electron Builder needs the platform package as a direct dependency under pnpm.",
    );
    assert.include(releaseWorkflowSource, "$speechSmoke = Start-Process");
    assert.include(releaseWorkflowSource, "$speechSmoke.ExitCode");
    assert.notInclude(
      releaseWorkflowSource,
      '& "apps/companion/dist/win-unpacked/Jarvis Companion.exe" --speech-smoke',
      "PowerShell does not wait for a GUI executable when it is invoked directly.",
    );
  });

  it("runs the production voice path during packaged speech smoke", () => {
    const smokeStart = mainSource.indexOf("if (packagedSpeechSmoke)");
    const prepareMicrophone = mainSource.indexOf("prepareNativeMicrophone()", smokeStart);
    const prepareRecognition = mainSource.indexOf(
      "prepareParakeetRecognition(parakeetPaths().paths)",
      smokeStart,
    );
    const prepare = mainSource.indexOf("prepareNativeSpeech()", smokeStart);
    const speak = mainSource.indexOf(
      'await speakCompanionSpeech("Jarvis Companion voice is ready.");',
      smokeStart,
    );
    const dispose = mainSource.indexOf("await disposeNativeSpeech()", speak);
    assert.isAtLeast(smokeStart, 0);
    assert.isAbove(prepareMicrophone, smokeStart);
    assert.isAbove(prepareRecognition, prepareMicrophone);
    assert.isAbove(prepare, smokeStart);
    assert.isAbove(prepare, prepareMicrophone);
    assert.isAbove(speak, prepare);
    assert.isAbove(dispose, speak);
  });

  it("surfaces structured Test voice failures in the setup UI", () => {
    const testVoiceHandler = mainSource.indexOf('ipcMain.handle("jarvis-companion:test-voice"');
    const handlerEnd = mainSource.indexOf("  });", testVoiceHandler);
    const handler = mainSource.slice(testVoiceHandler, handlerEnd);
    assert.include(handler, "catch (cause)");
    assert.include(handler, "ok: false");
    assert.include(handler, "companionSpeechFailureMessage(cause)");
    assert.include(mainSource, "if(!result||result.ok!==true)");
    assert.include(mainSource, "result&&result.message");
    assert.include(mainSource, "catch(error)");
  });

  it("requires the installed NSIS executable to pass the speech smoke", () => {
    assert.include(releaseWorkflowSource, "Jarvis-Companion-$version-x64.exe");
    assert.include(releaseWorkflowSource, "-ArgumentList @('/S', $installArgument)");
    assert.include(releaseWorkflowSource, "$installArgument = '/D=' + $installRoot");
    assert.include(releaseWorkflowSource, '"--speech-smoke"');
    assert.include(releaseWorkflowSource, 'Join-Path $installRoot "Jarvis Companion.exe"');
    assert.include(
      releaseWorkflowSource,
      'Join-Path $installRoot "Uninstall Jarvis Companion.exe"',
    );
    assert.include(
      releaseWorkflowSource,
      "Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force",
    );
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
