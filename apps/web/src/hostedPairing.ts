import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "./pairingUrl";

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export type HostedAppChannel = "latest" | "nightly";

export function configuredHostedAppUrl(): string {
  const configured = import.meta.env.VITE_HOSTED_APP_URL?.trim();
  if (configured) {
    return configured;
  }
  return typeof window !== "undefined" && window.location ? window.location.origin : "";
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  return channel === "latest" || channel === "nightly" ? channel : null;
}

function originFromUrl(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isHostedStaticApp(url?: URL): boolean {
  if (
    (typeof window !== "undefined" && window.desktopBridge !== undefined) ||
    configuredBackendUrl()
  ) {
    return false;
  }

  // No window, or a window without a location (tests, static render), means
  // no origin to be hosted at.
  if (url === undefined && (typeof window === "undefined" || window.location === undefined)) {
    return false;
  }

  const currentUrl = url ?? new URL(window.location.href);
  if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
    return false;
  }
  if (configuredHostedAppChannel()) {
    return true;
  }

  // The origin fallback is for building pairing links. It does not mean this
  // install is hosted: that would suppress discovery of its own backend.
  const hostedOrigin = originFromUrl(import.meta.env.VITE_HOSTED_APP_URL?.trim() ?? "");
  return hostedOrigin !== null && currentUrl.origin === hostedOrigin;
}

export function readHostedPairingRequest(url: URL = new URL(window.location.href)) {
  const host = url.searchParams.get("host")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  } satisfies HostedPairingRequest;
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string {
  const url = new URL("/pair", configuredHostedAppUrl());
  url.searchParams.set("host", input.host);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}

export function buildHostedChannelSelectionUrl(input: {
  readonly channel: HostedAppChannel;
}): string {
  const url = new URL("/__t3code/channel", configuredHostedAppUrl());
  url.searchParams.set("channel", input.channel);
  return url.toString();
}
