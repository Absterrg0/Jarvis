import type { CirceLiveVoiceStatus } from "./CirceLiveVoice.logic";

export interface CirceLiveVoiceSink {
  /** Append a result the live model should say aloud. */
  readonly speak: (text: string) => void;
  /** Append quiet progress context. */
  readonly note: (text: string) => void;
}

export type CirceLiveVoiceDelegateHandler = (utterance: string, delegationId: string) => boolean;

export interface CirceLiveVoiceUiState {
  readonly active: boolean;
  readonly status: CirceLiveVoiceStatus;
}

let sink: CirceLiveVoiceSink | null = null;
let delegate: CirceLiveVoiceDelegateHandler | null = null;
let uiState: CirceLiveVoiceUiState = { active: false, status: "idle" };
let liveVoiceEnabled = false;
let activationReason: "user" | "announcement" = "user";
let pendingAnnouncements: string[] = [];
const listeners = new Set<() => void>();

/** Bounded queue: a burst of reports must not grow without limit. */
export const CIRCE_LIVE_VOICE_MAX_PENDING_ANNOUNCEMENTS = 8;

const sameUiState = (left: CirceLiveVoiceUiState, right: CirceLiveVoiceUiState) =>
  left.active === right.active && left.status === right.status;

const updateUiState = (next: CirceLiveVoiceUiState) => {
  if (sameUiState(uiState, next)) return;
  uiState = next;
  for (const listener of listeners) listener();
};

/** The active live session, or null when speech should use the normal TTS lanes. */
export const getCirceLiveVoiceSink = (): CirceLiveVoiceSink | null => sink;

export const setCirceLiveVoiceSink = (next: CirceLiveVoiceSink | null): void => {
  sink = next;
};

/**
 * The one submission handler for delegated live utterances. It lives in the
 * voice runtime so live speech reuses the same queue, grounding, and
 * clarification state as push-to-talk.
 */
export const registerCirceLiveVoiceDelegate = (
  handler: CirceLiveVoiceDelegateHandler,
): (() => void) => {
  delegate = handler;
  return () => {
    if (delegate === handler) delegate = null;
  };
};

export const submitCirceLiveVoiceDelegation = (utterance: string, delegationId: string): boolean =>
  delegate?.(utterance, delegationId) ?? false;

export const getCirceLiveVoiceUiState = (): CirceLiveVoiceUiState => uiState;

/**
 * True when the node has a live voice key. Reports then speak through a
 * short live session instead of a local TTS lane that does not exist in a
 * realtime-only build.
 */
export const setCirceLiveVoiceEnabled = (enabled: boolean): void => {
  liveVoiceEnabled = enabled;
};

export const getCirceLiveVoiceEnabled = (): boolean => liveVoiceEnabled;

/**
 * Speak one report when no session is live. An active session takes the text
 * immediately; otherwise a muted announcement session starts and reads it.
 */
export const requestCirceLiveVoiceAnnouncement = (text: string): void => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  if (sink !== null) {
    sink.speak(trimmed);
    return;
  }
  pendingAnnouncements = [...pendingAnnouncements, trimmed].slice(
    -CIRCE_LIVE_VOICE_MAX_PENDING_ANNOUNCEMENTS,
  );
  activationReason = "announcement";
  setCirceLiveVoiceActive(true);
};

/** Why the current activation started; resets to a user session afterward. */
export const consumeCirceLiveVoiceActivationReason = (): "user" | "announcement" => {
  const reason = activationReason;
  activationReason = "user";
  return reason;
};

export const takeCirceLiveVoiceAnnouncements = (): ReadonlyArray<string> => {
  const announcements = pendingAnnouncements;
  pendingAnnouncements = [];
  return announcements;
};

export const setCirceLiveVoiceActive = (active: boolean): void => {
  updateUiState({ active, status: active ? uiState.status : "idle" });
};

export const setCirceLiveVoiceStatus = (status: CirceLiveVoiceStatus): void => {
  updateUiState({ ...uiState, status });
};

export const subscribeCirceLiveVoice = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
