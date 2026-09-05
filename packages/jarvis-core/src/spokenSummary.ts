/**
 * Shared spoken-summary policy for voice clients. Durable task UI keeps the
 * full result text; speech gets a normalized, bounded summary so Markdown,
 * code fences, and paragraph-long reports never reach text-to-speech raw.
 * Mobile and web share normalization here and differ only in length budget.
 */

/** Strip code blocks and Markdown punctuation down to speakable words. */
export function normalizeSpokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " The code details are waiting in your workspace. ")
    .replace(/[`#*_\]>()]/gu, " ")
    .replace(/\[/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.!?;:])/gu, "$1")
    .trim();
}

/**
 * Bound a normalized completion to a spoken summary: whole sentences first,
 * then a hard character cap with an ellipsis. Non-completion kinds speak in
 * full through their own prefixes, so only completions truncate.
 */
export function selectSpokenSummary(text: string, maximum: number): string {
  const normalized = normalizeSpokenText(text);
  if (normalized.length <= maximum) return normalized;
  // Reserve the last character for the ellipsis: searching at maximum - 1
  // could select it, pushing the spoken text one past the budget.
  const sentenceEnd = normalized.lastIndexOf(". ", maximum - 2);
  const cut = sentenceEnd > 120 ? sentenceEnd + 1 : maximum - 1;
  return `${normalized.slice(0, cut).trim()}…`;
}
