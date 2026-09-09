export type MobileVoicePhase =
  | "idle"
  | "preparing"
  | "recording"
  | "transcribing"
  | "speaking"
  | "synthesizing";

export type CaptureReleaseAction = "ignore" | "defer" | "finish";

export type MicrophonePermissionAction = "start" | "request" | "blocked";

export function resolveMicrophonePermissionAction(input: {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}): MicrophonePermissionAction {
  if (input.granted) return "start";
  return input.canAskAgain ? "request" : "blocked";
}

export function shouldAbortCapturePreparation(input: {
  readonly generationChanged: boolean;
  readonly pushToTalkHeld: boolean;
}): boolean {
  return input.generationChanged;
}

export function resolveCaptureReleaseAction(input: {
  readonly captureStarting: boolean;
  readonly captureActive: boolean;
}): CaptureReleaseAction {
  if (input.captureStarting) return "defer";
  if (!input.captureActive) return "ignore";
  return "finish";
}

const MAX_HEARD_TRANSCRIPT_LENGTH = 120;

/** Keep the retained transcript short enough for one status line. */
export function truncateMobileVoiceTranscript(transcript: string): string {
  const normalized = transcript.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_HEARD_TRANSCRIPT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_HEARD_TRANSCRIPT_LENGTH - 1).trim()}…`;
}

/**
 * Immediate capture feedback through the existing message owner. The heard
 * transcript stays visible so a later interpreting/accepted update never
 * blanks it back to silence.
 */
export function formatMobileVoiceHeardMessage(transcript: string): string {
  const retained = truncateMobileVoiceTranscript(transcript);
  return retained.length === 0 ? "Heard your request." : `Heard: "${retained}"`;
}

/**
 * Submission feedback that stays truthful: the request is being interpreted,
 * not accepted, and no task progress is claimed. The retained transcript
 * travels along so correction stays possible.
 */
export function formatMobileVoiceInterpretingMessage(utterance: string): string {
  const retained = truncateMobileVoiceTranscript(utterance);
  return retained.length === 0
    ? "Interpreting your request…"
    : `${formatMobileVoiceHeardMessage(retained)} Interpreting…`;
}

/**
 * Honest race for a correction cancel: only a capture still in flight reports
 * cancellation, and it never claims success. Idle and speaking phases stay
 * silent so a stray release cannot rewrite real progress.
 */
export function resolveMobileVoiceCancelMessage(phase: MobileVoicePhase): string | null {
  if (phase === "preparing" || phase === "recording" || phase === "transcribing") {
    return "Cancelled. Your transcript is kept above; edit and resend when ready.";
  }
  return null;
}

/**
 * Stale speech suppression for completion-before-ack: a second copy of text
 * already queued for the same turn is dropped instead of spoken twice.
 * Identity is threadKey plus turnId when known, else the shared requestId.
 * originInteractionId never decides: one origin may be reused across later
 * legitimate turns. Callers without turn identity keep the legacy text-only
 * check.
 */
export function shouldSuppressDuplicateMobileSpeech(
  queued: ReadonlyArray<{
    readonly text: string;
    readonly threadKey?: string;
    readonly turnId?: unknown;
    readonly requestId?: string;
    readonly originInteractionId?: string;
  }>,
  text: string,
  request?: {
    readonly threadKey?: string;
    readonly turnId?: unknown;
    readonly requestId?: string;
    readonly originInteractionId?: string;
  },
): boolean {
  return queued.some((item) => {
    if (item.text !== text) return false;
    if (request === undefined) return true;
    if ((item.threadKey ?? "") !== (request.threadKey ?? "")) return false;
    const itemTurn = typeof item.turnId === "string" ? item.turnId : undefined;
    const requestTurn = typeof request.turnId === "string" ? request.turnId : undefined;
    if (itemTurn !== undefined || requestTurn !== undefined) {
      return itemTurn !== undefined && itemTurn === requestTurn;
    }
    if (item.requestId !== undefined || request.requestId !== undefined) {
      return item.requestId !== undefined && item.requestId === request.requestId;
    }
    return true;
  });
}

export function isPushToTalkDisabled(input: {
  readonly submitting: boolean;
  readonly hasProject: boolean;
  readonly hasVoiceNode: boolean;
  readonly hasOnlineNode: boolean;
  readonly phase: MobileVoicePhase;
  readonly sttBackend?: "local" | "remote";
  readonly localAvailable?: boolean;
}): boolean {
  // Speaking stays enabled: pressing the button barges in and stops the
  // current playback. Transcribing stays disabled until the capture settles.
  // With no project at all, a voice node plus any online node still permits
  // project-free conversation. Explicit local STT runs on-device with or
  // without a voice node; remote STT still needs one.
  const sttNeedsVoiceNode =
    input.sttBackend !== "local" || input.localAvailable !== true ? true : false;
  return (
    input.submitting ||
    (!input.hasProject && !input.hasOnlineNode) ||
    (sttNeedsVoiceNode && !input.hasVoiceNode) ||
    input.phase === "transcribing"
  );
}
