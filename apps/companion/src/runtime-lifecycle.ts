/**
 * Companion is a controller for a paired Jarvis Host, not an execution node.
 *
 * The only runtime this process may dispose is its local speech runtime. The
 * paired Host (Full or Headless) owns the agent process and remains alive when
 * this controller exits.
 */
export async function disposeCompanionLocalRuntime(input: {
  readonly disposeSpeech: () => Promise<void>;
  /** Synchronous teardown that must happen before speech disposal begins. */
  readonly cancelCapture?: () => void;
  readonly clearCaptureDeadlines?: () => void;
}): Promise<void> {
  input.clearCaptureDeadlines?.();
  input.cancelCapture?.();
  await input.disposeSpeech();
}
