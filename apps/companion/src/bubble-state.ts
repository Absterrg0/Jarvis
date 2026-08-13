/** Keeps a hotkey capture queued until the actual bubble document is listening. */
export function takeCaptureForReadyBubble(input: {
  readonly bubbleReady: boolean;
  readonly capturePending: boolean;
}): { readonly capturePending: boolean; readonly shouldStart: boolean } {
  if (!input.bubbleReady || !input.capturePending) {
    return { capturePending: input.capturePending, shouldStart: false };
  }
  return { capturePending: false, shouldStart: true };
}

/**
 * A release can arrive while the first voice overlay document is loading.
 * In that case the document must render the latest phase, not replay an
 * obsolete listening event after its listener attaches.
 */
export function queuedBubbleCaptureEvent(input: {
  readonly bubbleReady: boolean;
  readonly capturePending: boolean;
  readonly phase: "listening" | "checking" | "idle";
}): { readonly capturePending: boolean; readonly event: "start" | "stop" | undefined } {
  if (!input.bubbleReady) {
    return { capturePending: input.capturePending, event: undefined };
  }
  if (input.phase === "checking") return { capturePending: false, event: "stop" };
  if (input.phase === "listening" && input.capturePending) {
    return { capturePending: false, event: "start" };
  }
  return { capturePending: false, event: undefined };
}

/** A second hotkey must not start another local recorder while one is active. */
export function canStartCapture(captureInFlight: boolean): boolean {
  return !captureInFlight;
}
