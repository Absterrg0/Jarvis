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

/**
 * Only explicit web addresses or app-owned names may launch. No inferred
 * schemes, credentials, or shell commands. Shared by the node that validates
 * a proposed launch and the client that performs it.
 */
export function circeWebsiteUrl(value: string): string | null {
  const candidate = value.trim();
  const known = KNOWN_WEBSITES[candidate.toLowerCase()];
  if (known !== undefined) return known;
  if (
    !/^https?:\/\/\S+$/i.test(candidate) &&
    !/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/?$/i.test(candidate)
  )
    return null;
  try {
    const url = new URL(/^https?:/i.test(candidate) ? candidate : `https://${candidate}`);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
