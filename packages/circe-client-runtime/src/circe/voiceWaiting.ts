/**
 * Pure waiting-UX helpers for one submission during the semantic call.
 * The submission queue in web runtime stays the state owner; these functions
 * only format its receipt, provisional target note, and truthful cancel text
 * so every surface reads the same words without a second state machine.
 */

export const CIRCE_SUBMISSION_RECEIPT_MAX_TRANSCRIPT = 140;

const truncateTranscript = (transcript: string): string => {
  const trimmed = transcript.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= CIRCE_SUBMISSION_RECEIPT_MAX_TRANSCRIPT) return trimmed;
  return `${trimmed.slice(0, CIRCE_SUBMISSION_RECEIPT_MAX_TRANSCRIPT - 1).trimEnd()}...`;
};

/**
 * Immediate receipt text for a newly enqueued capture. Null when there is
 * nothing to acknowledge, so callers never announce an empty transcript.
 * Always shown silently: the waiting window gets no filler speech.
 */
export function formatCirceVoiceReceipt(transcript: string): string | null {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return null;
  return `Heard: "${truncateTranscript(trimmed)}"`;
}

/**
 * Dispatch text replacing the generic working notice. Keeps the transcript
 * visible and never claims acceptance: the semantic call is still unanswered.
 */
export function formatCirceVoiceDispatching(transcript: string): string {
  return `Heard "${truncateTranscript(transcript)}", checking...`;
}

export type CirceVoiceEnqueueResult = "enqueued" | "duplicate" | "full" | "empty";

/** Only a newly enqueued capture earns a receipt; retries stay silent. */
export function shouldEmitCirceVoiceReceipt(result: CirceVoiceEnqueueResult): boolean {
  return result === "enqueued";
}

export type CirceVoiceFeedbackKind = "working" | "needs-input" | "error" | "done";

export interface CirceVoiceWaitingView {
  readonly provisional: boolean;
  readonly targetNote: string;
  readonly correctionHint: string;
}

/**
 * Derive the waiting block from typed runtime state, never from wording.
 * Visible only while a submission is dispatched and unanswered; settled,
 * failed, and clarification states return null so no stale chrome lingers
 * after acceptance.
 */
export function buildCirceVoiceWaitingView(input: {
  readonly busy: boolean;
  readonly awaitingAnswer: boolean;
  readonly feedbackKind: CirceVoiceFeedbackKind | null;
  readonly feedbackText: string | null;
  readonly targetLabel: string | null;
  readonly targetAvailable: boolean;
}): CirceVoiceWaitingView | null {
  if (!input.busy || input.awaitingAnswer) return null;
  if (input.feedbackKind !== "working") return null;
  if (input.feedbackText === null || input.feedbackText.trim().length === 0) return null;
  void input.targetAvailable;
  return {
    provisional: true,
    targetNote:
      input.targetLabel === null
        ? "No target yet, will ask before running."
        : `${input.targetLabel} (provisional, not yet accepted)`,
    correctionHint: "You can correct or cancel before it is accepted.",
  };
}

/**
 * Truthful cancel wording. A locally discarded queue never retracts an
 * already submitted request: there is no server cancel seam for accepted
 * work, so the message says the current request keeps running instead of
 * claiming it stopped.
 */
export function resolveCirceVoiceCancelMessage(input: {
  readonly inFlight: boolean;
  readonly discardedQueued: number;
}): string {
  const discarded = Math.max(0, input.discardedQueued);
  const discardedText =
    discarded === 0
      ? null
      : discarded === 1
        ? "Discarded 1 pending request."
        : `Discarded ${discarded} pending requests.`;
  if (input.inFlight) {
    const runningText = "The current request is already submitted and keeps running.";
    return discardedText === null
      ? runningText
      : `Discarded ${discarded} queued request${discarded === 1 ? "" : "s"}. ${runningText}`;
  }
  return discardedText ?? "Nothing to cancel.";
}
