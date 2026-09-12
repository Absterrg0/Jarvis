import type { JarvisLiveVoiceStatus } from "./JarvisLiveVoice.logic";

export interface JarvisLiveVoiceSink {
  /** Append a result the live model should say aloud. */
  readonly speak: (text: string) => void;
  /** Append quiet progress context. */
  readonly note: (text: string) => void;
}

export type JarvisLiveVoiceDelegateHandler = (utterance: string, delegationId: string) => boolean;

export interface JarvisLiveVoiceUiState {
  readonly active: boolean;
  readonly status: JarvisLiveVoiceStatus;
}

let sink: JarvisLiveVoiceSink | null = null;
let delegate: JarvisLiveVoiceDelegateHandler | null = null;
let uiState: JarvisLiveVoiceUiState = { active: false, status: "idle" };
let liveVoiceEnabled = false;
let activationReason: "user" | "announcement" = "user";
let pendingAnnouncements: string[] = [];
const listeners = new Set<() => void>();

/** Bounded queue: a burst of reports must not grow without limit. */
export const JARVIS_LIVE_VOICE_MAX_PENDING_ANNOUNCEMENTS = 8;

const sameUiState = (left: JarvisLiveVoiceUiState, right: JarvisLiveVoiceUiState) =>
  left.active === right.active && left.status === right.status;

const updateUiState = (next: JarvisLiveVoiceUiState) => {
  if (sameUiState(uiState, next)) return;
  uiState = next;
  for (const listener of listeners) listener();
};

/** The active live session, or null when speech should use the normal TTS lanes. */
export const getJarvisLiveVoiceSink = (): JarvisLiveVoiceSink | null => sink;

export const setJarvisLiveVoiceSink = (next: JarvisLiveVoiceSink | null): void => {
  sink = next;
};

/**
 * The one submission handler for delegated live utterances. It lives in the
 * voice runtime so live speech reuses the same queue, grounding, and
 * clarification state as push-to-talk.
 */
export const registerJarvisLiveVoiceDelegate = (
  handler: JarvisLiveVoiceDelegateHandler,
): (() => void) => {
  delegate = handler;
  return () => {
    if (delegate === handler) delegate = null;
  };
};

export const submitJarvisLiveVoiceDelegation = (utterance: string, delegationId: string): boolean =>
  delegate?.(utterance, delegationId) ?? false;

export const getJarvisLiveVoiceUiState = (): JarvisLiveVoiceUiState => uiState;

/**
 * True when the node has a live voice key. Reports then speak through a
 * short live session instead of a local TTS lane that does not exist in a
 * realtime-only build.
 */
export const setJarvisLiveVoiceEnabled = (enabled: boolean): void => {
  liveVoiceEnabled = enabled;
};

export const getJarvisLiveVoiceEnabled = (): boolean => liveVoiceEnabled;

/**
 * Speak one report when no session is live. An active session takes the text
 * immediately; otherwise a muted announcement session starts and reads it.
 */
export const requestJarvisLiveVoiceAnnouncement = (text: string): void => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  if (sink !== null) {
    sink.speak(trimmed);
    return;
  }
  pendingAnnouncements = [...pendingAnnouncements, trimmed].slice(
    -JARVIS_LIVE_VOICE_MAX_PENDING_ANNOUNCEMENTS,
  );
  activationReason = "announcement";
  setJarvisLiveVoiceActive(true);
};

/** Why the current activation started; resets to a user session afterward. */
export const consumeJarvisLiveVoiceActivationReason = (): "user" | "announcement" => {
  const reason = activationReason;
  activationReason = "user";
  return reason;
};

export const takeJarvisLiveVoiceAnnouncements = (): ReadonlyArray<string> => {
  const announcements = pendingAnnouncements;
  pendingAnnouncements = [];
  return announcements;
};

export const setJarvisLiveVoiceActive = (active: boolean): void => {
  updateUiState({ active, status: active ? uiState.status : "idle" });
};

export const setJarvisLiveVoiceStatus = (status: JarvisLiveVoiceStatus): void => {
  updateUiState({ ...uiState, status });
};

export const subscribeJarvisLiveVoice = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
