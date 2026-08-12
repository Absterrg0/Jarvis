export type CompanionLaunch =
  | {
      readonly kind: "pairing";
      readonly host: string;
      readonly url: string;
    }
  | {
      readonly kind: "remote";
      readonly host: string;
      readonly url: string;
    }
  | { readonly kind: "setup" };

function normalizeHost(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function pairingUrlFromArgs(argv: readonly string[]): string | null {
  const prefix = "--pairing-url=";
  const argument = argv.find((value) => value.startsWith(prefix));
  return argument === undefined ? null : argument.slice(prefix.length);
}

function isPairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const token =
      url.searchParams.get("token") ?? new URLSearchParams(url.hash.slice(1)).get("token");
    return (token?.trim().length ?? 0) > 0;
  } catch {
    return false;
  }
}

export function resolveCompanionLaunch(input: {
  readonly argv: readonly string[];
  readonly savedHost: string | null;
}): CompanionLaunch {
  const pairingUrl = pairingUrlFromArgs(input.argv);
  if (pairingUrl !== null && isPairingUrl(pairingUrl)) {
    const host = normalizeHost(pairingUrl);
    if (host !== null) return { kind: "pairing", host, url: pairingUrl };
  }

  if (input.savedHost !== null) {
    const host = normalizeHost(input.savedHost);
    if (host !== null) return { kind: "remote", host, url: host };
  }

  return { kind: "setup" };
}
