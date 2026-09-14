import { circeWebsiteUrl } from "@circe/core/website";

/** Opening for the user belongs to their client, even when their selected task is remote. */
export async function openCirceWebsite(url: string): Promise<boolean> {
  const safe = circeWebsiteUrl(url);
  if (safe === null) return false;
  if (window.desktopBridge !== undefined) return window.desktopBridge.openExternal(safe);
  // Browser permission may block a voice-triggered popup. Report that instead of opening a hidden tab.
  const opened = window.open(safe, "_blank");
  if (opened === null) return false;
  opened.opener = null;
  opened.focus();
  return true;
}
