/**
 * A relay is ready as soon as its authenticated application document has
 * loaded. The preload owns buffering, so React does not need to be mounted
 * before the native companion can safely send a voice transcript.
 */
export function isRelayDocument(url: string): boolean {
  try {
    const location = new URL(url);
    return (
      (location.protocol === "http:" || location.protocol === "https:") &&
      location.pathname !== "/pair"
    );
  } catch {
    return false;
  }
}
