/** App-owned names that may launch without a full URL. Nothing inferred beyond this map. */
const KNOWN_WEBSITES: Readonly<Record<string, string>> = {
  youtube: "https://www.youtube.com/",
  "you tube": "https://www.youtube.com/",
  yt: "https://www.youtube.com/",
  google: "https://www.google.com/",
  github: "https://github.com/",
  wikipedia: "https://www.wikipedia.org/",
  reddit: "https://www.reddit.com/",
  netflix: "https://www.netflix.com/",
  spotify: "https://open.spotify.com/",
};

// Plain lowercasing and whitespace folding only: aliases and addresses are
// ASCII, and this must parse on every JS engine the clients run.
const normalizeText = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

const normalizeAddress = (value: string): string =>
  normalizeText(value)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//u, "")
    .replace(/^www\./u, "")
    .replace(/\/+$/u, "");

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Whole-token presence of a phrase in already-normalized text. The token may
 * not sit inside a longer word or a longer domain: "yt" does not match in
 * "python" or "yt.example", and "example.com" does not match in
 * "myexample.com" or "example.com.evil". A trailing sentence period is
 * allowed, because it is not followed by a domain label. The leading
 * boundary is part of the match (no lookbehind) so this runs on every JS
 * engine Hermes included.
 */
function containsToken(haystack: string, token: string): boolean {
  const needle = normalizeText(token);
  if (needle.length === 0) return false;
  const pattern = needle.split(" ").map(escapeRegExp).join("\\s+");
  return new RegExp(`(?:^|[^a-z0-9.])(${pattern})(?![a-z0-9])(?!\\.[a-z])`, "u").test(haystack);
}

/**
 * Resolve a proposed website launch to a concrete URL, grounded in what the
 * user actually said. The model proposes a name or URL; this function is the
 * deterministic authority:
 *
 * - An app-owned alias (YouTube, Google, ...) resolves only when some alias
 *   for that same site appears as a token in the utterance.
 * - An explicit http(s) URL or domain resolves only when its normalized
 *   address (scheme, leading www, and trailing slash removed) appears as a
 *   token in the utterance.
 *
 * Nothing else may launch. No inferred schemes, credentials, or shell
 * commands, and no target the user never spoke. Shared by the node that
 * validates a proposed launch and the client that performs it.
 */
export function circeWebsiteUrl(value: string, sourceUtterance?: string): string | null {
  const candidate = value.trim();
  if (candidate.length === 0) return null;
  const source = sourceUtterance === undefined ? "" : normalizeText(sourceUtterance);

  const known = KNOWN_WEBSITES[candidate.toLowerCase()];
  if (known !== undefined) {
    const aliases = Object.entries(KNOWN_WEBSITES)
      .filter(([, url]) => url === known)
      .map(([alias]) => alias);
    return aliases.some((alias) => containsToken(source, alias)) ? known : null;
  }

  if (
    !/^https?:\/\/\S+$/i.test(candidate) &&
    !/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/?$/i.test(candidate)
  )
    return null;
  let url: URL;
  try {
    url = new URL(/^https?:/i.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  return containsToken(source, normalizeAddress(url.href)) ? url.href : null;
}
