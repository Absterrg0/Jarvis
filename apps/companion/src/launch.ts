type CompanionLaunchOwnership = { readonly managed?: true; readonly controller?: true };

export type CompanionLaunch =
  | (CompanionLaunchOwnership & {
      readonly kind: "pairing";
      readonly host: string;
      readonly url: string;
    })
  | (CompanionLaunchOwnership & {
      readonly kind: "remote";
      readonly host: string;
      readonly url: string;
    })
  | (CompanionLaunchOwnership & { readonly kind: "setup" });

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

function copiedUrl(value: string): string | null {
  const withoutInvisibleCharacters = value.replace(/[\u200B-\u200D\uFEFF]/gu, "").trim();
  const markdownUrl = withoutInvisibleCharacters.match(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/u)?.[1];
  const rawUrl = withoutInvisibleCharacters.match(/https?:\/\/[^\s<>"']+/u)?.[0];
  const candidate = markdownUrl ?? rawUrl ?? withoutInvisibleCharacters;
  return candidate.replace(/[.,;]+$/u, "") || null;
}

function canonicalPairingUrl(url: URL): URL | null {
  if (url.pathname.replace(/\/+$/u, "") !== "/pair") return null;
  const token =
    url.searchParams.get("token") ?? new URLSearchParams(url.hash.slice(1)).get("token");
  if (token === null || token.trim().length === 0) return null;
  if (url.origin !== "https://app.t3.codes") return url;

  const encodedHost = url.searchParams.get("host");
  if (encodedHost === null) return null;
  const host = normalizeHost(encodedHost);
  if (host === null) return null;
  const direct = new URL("pair", host);
  direct.hash = new URLSearchParams({ token }).toString();
  return direct;
}

/** Extracts a full pairing URL whether it was copied as plain text or a rich-text link. */
export function resolvePairingLink(
  value: string,
): Extract<CompanionLaunch, { readonly kind: "pairing" }> | null {
  const candidate = copiedUrl(value);
  if (candidate === null) return null;
  try {
    const url = new URL(candidate);
    const direct = canonicalPairingUrl(url);
    if (direct === null) return null;
    const host = normalizeHost(direct.toString());
    return host === null ? null : { kind: "pairing", host, url: direct.toString() };
  } catch {
    return null;
  }
}

export function resolveCompanionLaunch(input: {
  readonly argv: readonly string[];
  readonly savedHost: string | null;
}): CompanionLaunch {
  const managed = input.argv.includes("--jarvis-managed");
  const controller = input.argv.includes("--jarvis-controller");
  const withOwnership = <T extends { readonly kind: CompanionLaunch["kind"] }>(
    action: T,
  ): T & CompanionLaunchOwnership =>
    managed || controller
      ? {
          ...action,
          ...(managed ? { managed: true } : {}),
          ...(controller ? { controller: true } : {}),
        }
      : action;
  const pairingUrl = pairingUrlFromArgs(input.argv);
  if (pairingUrl !== null) {
    const pairing = resolvePairingLink(pairingUrl);
    if (pairing !== null) return withOwnership(pairing);
  }

  if (input.savedHost !== null) {
    const host = normalizeHost(input.savedHost);
    if (host !== null) return withOwnership({ kind: "remote", host, url: host });
  }

  return withOwnership({ kind: "setup" });
}
