import { describe, expect, it } from "vite-plus/test";

import {
  buildCirceVoiceWaitingView,
  formatCirceVoiceDispatching,
  formatCirceVoiceReceipt,
  resolveCirceVoiceCancelMessage,
  shouldEmitCirceVoiceReceipt,
} from "./voiceWaiting.ts";

describe("circe voice waiting", () => {
  it("emits no receipt for an empty transcript", () => {
    expect(formatCirceVoiceReceipt("   ")).toBeNull();
    expect(formatCirceVoiceReceipt("")).toBeNull();
  });

  it("keeps the receipt short with the transcript intact", () => {
    const receipt = formatCirceVoiceReceipt("Fix the login bug");
    expect(receipt).toBe('Heard: "Fix the login bug"');
    const long = formatCirceVoiceReceipt(`Fix ${"very ".repeat(60)}long bug`);
    expect(long).not.toBeNull();
    expect(long!.length).toBeLessThanOrEqual(160);
    expect(long!.startsWith('Heard: "Fix ')).toBe(true);
  });

  it("emits a receipt only for a newly enqueued capture", () => {
    expect(shouldEmitCirceVoiceReceipt("enqueued")).toBe(true);
    expect(shouldEmitCirceVoiceReceipt("duplicate")).toBe(false);
    expect(shouldEmitCirceVoiceReceipt("full")).toBe(false);
    expect(shouldEmitCirceVoiceReceipt("empty")).toBe(false);
  });

  it("shows no waiting chrome once the request settles or asks a question", () => {
    const base = {
      targetLabel: "Rivvl — Laptop",
      targetAvailable: true,
      feedbackText: 'Heard: "Fix the bug"',
    } as const;
    expect(
      buildCirceVoiceWaitingView({
        ...base,
        busy: false,
        awaitingAnswer: false,
        feedbackKind: "working",
      }),
    ).toBeNull();
    expect(
      buildCirceVoiceWaitingView({
        ...base,
        busy: true,
        awaitingAnswer: true,
        feedbackKind: "needs-input",
      }),
    ).toBeNull();
    expect(
      buildCirceVoiceWaitingView({
        ...base,
        busy: false,
        awaitingAnswer: false,
        feedbackKind: "done",
        feedbackText: "Working on the bug.",
      }),
    ).toBeNull();
    expect(
      buildCirceVoiceWaitingView({
        ...base,
        busy: true,
        awaitingAnswer: false,
        feedbackKind: "error",
      }),
    ).toBeNull();
  });

  it("marks the target provisional while the semantic call is unaccepted", () => {
    const view = buildCirceVoiceWaitingView({
      busy: true,
      awaitingAnswer: false,
      feedbackKind: "working",
      feedbackText: 'Heard: "Fix the bug"',
      targetLabel: "Rivvl — Laptop",
      targetAvailable: true,
    });
    expect(view).not.toBeNull();
    expect(view!.provisional).toBe(true);
    expect(view!.targetNote).toBe("Rivvl — Laptop (provisional, not yet accepted)");
  });

  it("admits a missing target instead of guessing one", () => {
    const view = buildCirceVoiceWaitingView({
      busy: true,
      awaitingAnswer: false,
      feedbackKind: "working",
      feedbackText: 'Heard: "Fix the bug"',
      targetLabel: null,
      targetAvailable: false,
    });
    expect(view?.targetNote).toBe("No target yet, will ask before running.");
  });

  it("keeps dispatch text provisional and silent", () => {
    const text = formatCirceVoiceDispatching("Fix the login bug");
    expect(text).toBe('Heard "Fix the login bug", checking...');
    expect(text).not.toContain("accepted");
  });

  it("tells the truth when the current request is already submitted", () => {
    expect(resolveCirceVoiceCancelMessage({ inFlight: true, discardedQueued: 2 })).toBe(
      "Discarded 2 queued requests. The current request is already submitted and keeps running.",
    );
    expect(resolveCirceVoiceCancelMessage({ inFlight: true, discardedQueued: 0 })).toBe(
      "The current request is already submitted and keeps running.",
    );
    expect(resolveCirceVoiceCancelMessage({ inFlight: false, discardedQueued: 1 })).toBe(
      "Discarded 1 pending request.",
    );
    expect(resolveCirceVoiceCancelMessage({ inFlight: false, discardedQueued: 0 })).toBe(
      "Nothing to cancel.",
    );
  });
});
