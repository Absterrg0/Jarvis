export type MobileVoicePhase = "idle" | "preparing" | "recording" | "transcribing" | "speaking";

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

export function isPushToTalkDisabled(input: {
  readonly submitting: boolean;
  readonly hasProject: boolean;
  readonly hasVoiceNode: boolean;
  readonly hasOnlineNode: boolean;
  readonly phase: MobileVoicePhase;
}): boolean {
  // Speaking stays enabled: pressing the button barges in and stops the
  // current playback. Transcribing stays disabled until the capture settles.
  // With no project at all, a voice node plus any online node still permits
  // project-free conversation.
  return (
    input.submitting ||
    (!input.hasProject && !input.hasOnlineNode) ||
    !input.hasVoiceNode ||
    input.phase === "transcribing"
  );
}
