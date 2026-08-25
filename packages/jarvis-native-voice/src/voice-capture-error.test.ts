import { assert, describe, it } from "@effect/vitest";

import {
  classifyVoiceCaptureError,
  createVoiceCaptureError,
  isVoiceCaptureErrorCode,
} from "./voice-capture-error.ts";

describe("voice capture errors", () => {
  it("keeps stable codes and classifies native messages", () => {
    assert.isTrue(isVoiceCaptureErrorCode("no-audio-frames"));
    assert.equal(
      classifyVoiceCaptureError(createVoiceCaptureError("capture-timeout", "late")),
      "capture-timeout",
    );
    assert.equal(classifyVoiceCaptureError(new Error("permission denied")), "permission-denied");
    assert.equal(classifyVoiceCaptureError(new Error("No input device")), "no-input-device");
    assert.equal(classifyVoiceCaptureError(new Error("No audio frames")), "no-audio-frames");
    assert.equal(
      classifyVoiceCaptureError(new Error("I didn't hear a complete instruction. Try again.")),
      "no-audio-frames",
    );
    assert.equal(
      classifyVoiceCaptureError(new Error("Microphone unavailable: permission denied")),
      "permission-denied",
    );
    assert.equal(classifyVoiceCaptureError(new Error("cancelled")), "cancelled");
  });
});
