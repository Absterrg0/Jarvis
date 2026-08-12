const JARVIS_PREFERENCES_CHANGED_EVENT = "t3code:jarvis-preferences-changed";
const VOICE_REPORTS_ENABLED_KEY = "t3code:jarvis:voice-reports-enabled:v1";
export const PREFERRED_SPEAKER_KEY = "t3code:jarvis:preferred-speaker:v1";

export function areJarvisVoiceReportsEnabled(): boolean {
  return localStorage.getItem(VOICE_REPORTS_ENABLED_KEY) !== "false";
}

export function setJarvisVoiceReportsEnabled(enabled: boolean): void {
  localStorage.setItem(VOICE_REPORTS_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new Event(JARVIS_PREFERENCES_CHANGED_EVENT));
}

export function isPreferredJarvisSpeaker(): boolean {
  return localStorage.getItem(PREFERRED_SPEAKER_KEY) === "true";
}

export function setPreferredJarvisSpeaker(preferred: boolean): void {
  localStorage.setItem(PREFERRED_SPEAKER_KEY, String(preferred));
  window.dispatchEvent(new Event(JARVIS_PREFERENCES_CHANGED_EVENT));
}

export function onJarvisPreferencesChanged(listener: () => void): () => void {
  window.addEventListener(JARVIS_PREFERENCES_CHANGED_EVENT, listener);
  return () => window.removeEventListener(JARVIS_PREFERENCES_CHANGED_EVENT, listener);
}
