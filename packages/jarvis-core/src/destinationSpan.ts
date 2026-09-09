/**
 * Exact source spans. A span is valid only when `source.slice(start, end)`
 * reproduces `text` byte-for-byte with no trimming: offsets prove the text
 * was copied from the source (mechanical copy proof), never that a role
 * attached to the span is correct. Role and catalog checks live in
 * `semanticEvidence.ts`; this module only proves and applies deletions.
 */

export interface SourceSpan {
  /** Offset into the source utterance (UTF-16 code units). */
  readonly start: number;
  /** End offset into the source utterance (UTF-16 code units). */
  readonly end: number;
}

/**
 * One shared catalog-name normalization for destination matching: every
 * side compares the same folded form, so evidence validated in one place
 * means the same match in the other.
 */
export function normalizeDestinationPhrase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function stripDestinationQuotes(value: string): string {
  return value.replace(/^["'“”]+|["'“”]+$/gu, "");
}

export interface QuoteSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Generic quoted literals in one source utterance. Quotes never authorize a
 * route on their own: both the bounded grammar and the semantic validator
 * refuse authorizing refs that overlap these spans. Bounded at 16 spans.
 */
export function findSourceQuoteSpans(source: string): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  const pattern = /"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    if (spans.length > 16) break;
  }
  return spans;
}

export const sourceSpanOverlapsQuotes = (
  start: number,
  end: number,
  quotes: ReadonlyArray<QuoteSpan>,
): boolean => quotes.some((quote) => start < quote.end && end > quote.start);

/**
 * Invocation wrapper owned by source text: only ARIS and Jarvis open one.
 * Any other leading name stays in source for catalog resolution. Offsets
 * are UTF-16 via slice lengths, so cited spans stay canonical. Shared here
 * so the grammar and the validator read the same source without importing
 * each other.
 */
export function stripJarvisInvocation(source: string): {
  readonly rest: string;
  readonly offset: number;
} {
  const match = /^\s*(ARIS|Jarvis)\s*(?:[,:\-–—]\s*|\s+)/iu.exec(source);
  if (match === null || match[0] === undefined) return { rest: source, offset: 0 };
  const offset = match[0].length;
  return { rest: source.slice(offset), offset };
}

// Closed negation heads for exclusion scope. Generic grammar tokens, not
// project phrases. A destination candidate preceded by one of these in the
// same clause is excluded, never a route.
const NEGATION_HEADS = ["not", "no", "never", "except", "excluding", "without"];

function foldForNegation(value: string): string {
  return normalizeDestinationPhrase(stripDestinationQuotes(value));
}

export function isInJarvisNegationScope(wrapperStartInRest: number, rest: string): boolean {
  const before = rest.slice(Math.max(0, wrapperStartInRest - 48), wrapperStartInRest);
  const folded = ` ${foldForNegation(before)} `;
  return NEGATION_HEADS.some((head) => folded.includes(` ${head} `));
}

/**
 * Source-owned exclusion check for the validator: true when a span starting
 * at a source offset sits in exclusion scope (a generic negation head in the
 * preceding clause). A destination there never routes; wrong proposals citing
 * it as a destination are structurally untrustworthy. Fail-closed in
 * semanticEvidence, never a parser guess.
 */
export function isJarvisNegatedSpan(source: string, spanStart: number): boolean {
  const { rest, offset } = stripJarvisInvocation(source);
  const startInRest = spanStart - offset;
  if (startInRest < 0) return false;
  return isInJarvisNegationScope(startInRest, rest);
}

/** True for spans the host may delete: integers, ordered, inside source. */
export function isDeletableSpan(source: string, span: SourceSpan): boolean {
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end <= source.length &&
    span.end > span.start
  );
}

/**
 * Delete validated wrapper spans from the source by joining the surviving
 * slices. Only the cited ranges disappear; every untouched character,
 * including inner spacing, survives byte-for-byte. No global whitespace
 * normalization runs here. Returns undefined when the spans are not
 * sorted, are out of bounds, or overlap, so callers keep the source
 * instead of cutting blindly.
 */
export function deleteSourceSpans(
  source: string,
  spans: ReadonlyArray<SourceSpan>,
): string | undefined {
  let cursor = 0;
  const kept: Array<string> = [];
  for (const span of spans) {
    if (!isDeletableSpan(source, span) || span.start < cursor) return undefined;
    kept.push(source.slice(cursor, span.start));
    cursor = span.end;
  }
  kept.push(source.slice(cursor));
  return kept.join("");
}
