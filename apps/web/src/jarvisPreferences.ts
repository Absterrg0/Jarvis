const JARVIS_PREFERENCES_CHANGED_EVENT = "t3code:jarvis-preferences-changed";
const VOICE_REPORTS_ENABLED_KEY = "t3code:jarvis:voice-reports-enabled:v1";

export function areJarvisVoiceReportsEnabled(): boolean {
  return localStorage.getItem(VOICE_REPORTS_ENABLED_KEY) !== "false";
}

export function setJarvisVoiceReportsEnabled(enabled: boolean): void {
  localStorage.setItem(VOICE_REPORTS_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new Event(JARVIS_PREFERENCES_CHANGED_EVENT));
}

export function onJarvisPreferencesChanged(listener: () => void): () => void {
  window.addEventListener(JARVIS_PREFERENCES_CHANGED_EVENT, listener);
  return () => window.removeEventListener(JARVIS_PREFERENCES_CHANGED_EVENT, listener);
}
