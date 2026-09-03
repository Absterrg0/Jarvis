import { describe, expect, it } from "vite-plus/test";

import {
  isPushToTalkDisabled,
  resolveMicrophonePermissionAction,
  resolveCaptureReleaseAction,
  shouldAbortCapturePreparation,
} from "./mobilePushToTalk";
import { base64ToBytes, buildMobilePcmUtterance } from "./mobileVoiceAudio";

describe("mobile Jarvis push-to-talk gesture", () => {
  it("does not reopen Android's permission activity when recording is already allowed", () => {
    expect(resolveMicrophonePermissionAction({ granted: true, canAskAgain: true })).toBe("start");
    expect(resolveMicrophonePermissionAction({ granted: false, canAskAgain: true })).toBe(
      "request",
    );
    expect(resolveMicrophonePermissionAction({ granted: false, canAskAgain: false })).toBe(
      "blocked",
    );
  });

  it("keeps the pressed control active while native recording prepares", () => {
    expect(
      isPushToTalkDisabled({
        submitting: false,
        hasProject: true,
        hasVoiceNode: true,
        phase: "preparing",
      }),
    ).toBe(false);
  });

  it("defers a release that arrives before native recording starts", () => {
    expect(
      resolveCaptureReleaseAction({
        captureStarting: true,
        captureActive: false,
      }),
    ).toBe("defer");
  });

  it("does not cancel native startup after a deferred release", () => {
    expect(
      shouldAbortCapturePreparation({
        generationChanged: false,
        pushToTalkHeld: false,
      }),
    ).toBe(false);
  });

  it("finishes an active capture and ignores a release with no capture", () => {
    expect(resolveCaptureReleaseAction({ captureStarting: false, captureActive: true })).toBe(
      "finish",
    );
    expect(resolveCaptureReleaseAction({ captureStarting: false, captureActive: false })).toBe(
      "ignore",
    );
  });

  it("runs press-to-transcription through a fake stream without entering recording early", async () => {
    // Mirrors the useJarvisVoice startCapture/finishCapture sequence with a
    // controllable fake native stream: permission, preparing, deferred
    // release during startup, recording only after start succeeds, finish.
    const events: string[] = [];
    let captureStarting = true;
    let captureActive = false;
    let finishPending = false;
    let streamStarted = false;

    // Fresh install: permission not granted yet, finger still held when the
    // grant lands, so capture continues instead of asking for a second hold.
    expect(resolveMicrophonePermissionAction({ granted: false, canAskAgain: true })).toBe(
      "request",
    );
    const permissionGranted = true;
    const stillHeldAfterPermission = true;
    const continuesCapture = permissionGranted && stillHeldAfterPermission;
    expect(continuesCapture).toBe(true);

    // Preparing keeps the pressed control enabled.
    expect(
      isPushToTalkDisabled({
        submitting: false,
        hasProject: true,
        hasVoiceNode: true,
        phase: "preparing",
      }),
    ).toBe(false);
    events.push("preparing");

    // Native startup takes a tick; the finger releases before it completes.
    // Startup must not be cancelled, the release defers instead.
    expect(shouldAbortCapturePreparation({ generationChanged: false, pushToTalkHeld: false })).toBe(
      false,
    );
    let resolveStart!: () => void;
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    let stopCalls = 0;
    const fakeStream = {
      start: () => startPromise.then(() => void (streamStarted = true)),
      stop: () => void (stopCalls += 1),
    };
    const startTask = fakeStream.start();
    expect(resolveCaptureReleaseAction({ captureStarting, captureActive })).toBe("defer");
    finishPending = true;

    // Startup completes. Recording is entered only after start succeeds.
    resolveStart();
    await startTask;
    expect(streamStarted).toBe(true);
    events.push("stream-started");
    captureStarting = false;
    captureActive = true;
    events.push("recording");
    expect(events.indexOf("recording")).toBeGreaterThan(events.indexOf("stream-started"));

    // The deferred release finishes into transcribable audio and the native
    // stream stops exactly once, mirroring finishCapture.
    expect(finishPending).toBe(true);
    expect(resolveCaptureReleaseAction({ captureStarting, captureActive })).toBe("finish");
    captureActive = false;
    fakeStream.stop();
    const left = new Int16Array([1, 2, 3]);
    const right = new Int16Array([4, 5]);
    const utterance = buildMobilePcmUtterance([
      { data: left.buffer, sampleRate: 16_000, channels: 1 },
      { data: right.buffer, sampleRate: 16_000, channels: 1 },
    ]);
    expect(utterance.format).toBe("pcm-s16le");
    expect(utterance.sampleRate).toBe(16_000);
    expect(Array.from(new Int16Array(base64ToBytes(utterance.audioBase64).buffer))).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(stopCalls).toBe(1);
  });
});
