/**
 * A relay is ready as soon as its authenticated application document has
 * loaded. The preload owns buffering, so React does not need to be mounted
 * before the native companion can safely send a voice transcript.
 */
export function isRelayDocument(url: string): boolean {
  try {
    const location = new URL(url);
    // Pairing is an in-page transition: after the credential is exchanged,
    // T3 changes from /pair to / without reloading the document. The preload
    // is already able to buffer a transcript there, so excluding /pair loses
    // the only reliable delivery point on a freshly paired companion.
    return location.protocol === "http:" || location.protocol === "https:";
  } catch {
    return false;
  }
}
