import { describe, expect, it } from "vite-plus/test";

import {
  isPushToTalkDisabled,
  resolveMicrophonePermissionAction,
  resolveCaptureReleaseAction,
  shouldAbortCapturePreparation,
} from "./mobilePushToTalk";

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
});
