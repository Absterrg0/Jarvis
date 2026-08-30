import { randomUUID } from "./lib/utils";

const JARVIS_DEVICE_ID_KEY = "t3code:jarvis:device-id:v1";

let browserDeviceId: string | undefined;

function persistedBrowserDeviceId(): string {
  if (browserDeviceId !== undefined) return browserDeviceId;

  const storage = window.localStorage;
  const existing = storage.getItem(JARVIS_DEVICE_ID_KEY)?.trim();
  if (existing) {
    browserDeviceId = existing;
    return browserDeviceId;
  }
  browserDeviceId = randomUUID();
  storage.setItem(JARVIS_DEVICE_ID_KEY, browserDeviceId);
  return browserDeviceId;
}

/** Stable reporter identity shared by voice delivery and routed task metadata. */
export function jarvisReporterIdentity(): string {
  return persistedBrowserDeviceId();
}
