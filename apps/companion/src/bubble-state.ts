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

/** A second hotkey must not start another local recorder while one is active. */
export function canStartCapture(captureInFlight: boolean): boolean {
  return !captureInFlight;
}
