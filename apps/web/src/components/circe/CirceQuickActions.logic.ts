import { circeWebsiteUrl } from "@circe/core/website";

/** Opening for the user belongs to their client, even when their selected task is remote. */
export async function openCirceWebsite(url: string, sourceUtterance: string): Promise<boolean> {
  const safe = circeWebsiteUrl(url, sourceUtterance);
  if (safe === null) return false;
  // A throwing bridge must read as a failed launch, never as a dropped turn.
  if (window.desktopBridge !== undefined) {
    try {
      return await window.desktopBridge.openExternal(safe);
    } catch {
      return false;
    }
  }
  // Browser permission may block a voice-triggered popup. Report that instead of opening a hidden tab.
  const opened = window.open(safe, "_blank");
  if (opened === null) return false;
  opened.opener = null;
  opened.focus();
  return true;
}
