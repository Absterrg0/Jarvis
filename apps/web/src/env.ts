/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.desktopBridge via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isElectron =
  typeof window !== "undefined" &&
  (window.desktopBridge !== undefined || window.jarvisCompanion !== undefined);

/**
 * The report-only renderer is created by Jarvis Companion's narrow Electron
 * preload. It is distinct from the local companion setup surface, which never
 * loads the web app.
 */
export const isJarvisCompanionRelay =
  typeof window !== "undefined" && window.jarvisCompanion?.relayMode === true;

export const isJarvisCompanion =
  typeof window !== "undefined" && window.jarvisCompanion !== undefined && !isJarvisCompanionRelay;
