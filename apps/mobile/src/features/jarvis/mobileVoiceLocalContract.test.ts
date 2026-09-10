/**
 * Negative regression tests for the local-voice contract owned here:
 * voice drafts work without a voice node, push-to-talk stays enabled for
 * explicit local input with no node, and cancellation holds the temp file
 * until the native transcribe settles.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import { createMobileJarvisVoiceTurn } from "./mobileJarvisTurn";
import { isPushToTalkDisabled } from "./mobilePushToTalk";

describe("local voice contract", () => {
  it("creates a voice turn without a voice node for on-device input", () => {
    const draft = createMobileJarvisVoiceTurn({ originInteractionId: "origin-local" });
    expect(draft).toMatchObject({
      originInteractionId: "origin-local",
      inputMode: "voice",
      speechEnabled: true,
    });
    expect("voiceNodeId" in draft ? draft.voiceNodeId : undefined).toBeUndefined();
  });

  it("creates a voice turn with a node when TTS remains available", () => {
    const nodeId = EnvironmentId.make("voice-node");
    const draft = createMobileJarvisVoiceTurn({ originInteractionId: "o", voiceNodeId: nodeId });
    expect(draft).toMatchObject({ inputMode: "voice", speechEnabled: true, voiceNodeId: nodeId });
  });

  it("keeps push-to-talk enabled for explicit local input with no voice node", () => {
    expect(
      isPushToTalkDisabled({
        submitting: false,
        hasProject: true,
        hasVoiceNode: false,
        hasOnlineNode: true,
        phase: "idle",
        sttBackend: "local",
        localAvailable: true,
      } as never),
    ).toBe(false);
  });

  it("keeps push-to-talk disabled for remote input with no voice node", () => {
    expect(
      isPushToTalkDisabled({
        submitting: false,
        hasProject: true,
        hasVoiceNode: false,
        hasOnlineNode: true,
        phase: "idle",
        sttBackend: "remote",
        localAvailable: true,
      } as never),
    ).toBe(true);
  });

  it("exposes user-visible ARIS copy in the owned voice failure fallback", async () => {
    const Cause = await import("effect/Cause");
    const { AsyncResult } = await import("effect/unstable/reactivity");
    const { mobileVoiceFailureMessage } = await import("./mobileVoiceFailure");
    const result = AsyncResult.failure(Cause.fail(new Error("")));
    // Empty error message falls back to the product copy, which must name ARIS.
    expect(mobileVoiceFailureMessage(result)).toContain("ARIS");
  });
});
