const CIRCE_PREFERENCES_CHANGED_EVENT = "t3code:circe-preferences-changed";
const VOICE_REPORTS_ENABLED_KEY = "t3code:circe:voice-reports-enabled:v1";

export function areCirceVoiceReportsEnabled(): boolean {
  return localStorage.getItem(VOICE_REPORTS_ENABLED_KEY) !== "false";
}

export function setCirceVoiceReportsEnabled(enabled: boolean): void {
  localStorage.setItem(VOICE_REPORTS_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new Event(CIRCE_PREFERENCES_CHANGED_EVENT));
}

export function onCircePreferencesChanged(listener: () => void): () => void {
  window.addEventListener(CIRCE_PREFERENCES_CHANGED_EVENT, listener);
  // Same-tab writes dispatch the custom event above, but another tab's write
  // only fires a storage event: listen for both so every tab follows the key.
  const onStorage = (event: StorageEvent): void => {
    if (event.key === VOICE_REPORTS_ENABLED_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CIRCE_PREFERENCES_CHANGED_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
