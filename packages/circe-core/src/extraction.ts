import {
  decodeCirceSemanticProposal,
  type CirceSemanticProposal,
  type SemanticRef,
  type SemanticRole,
} from "./semanticEvidence.ts";

/**
 * Role-based adapter for the supervised extraction model (label schema
 * roles-v1).
 *
 * The model proposes labeled spans over the exact request text with Unicode
 * codepoint offsets (Python len() semantics, shared with
 * scripts/circe-extract). The semantic contract takes UTF-16 source spans
 * (semanticEvidence.ts: `source.slice(start, end) === text` must hold), so
 * every offset passes through the one canonical conversion below. JS string
 * indexing is UTF-16; presenting codepoint offsets raw would shift every
 * span after the first astral character and break copy proof.
 *
 * Roles-v1 labels (scripts/circe-extract, train --label-schema roles-v1):
 * DESTINATION -> destination ref; the span is the full routing wrapper
 *   (`in X`, `to X`, `In X,` etc). The value is the named project derived
 *   with bounded wrapper syntax (leading routing preposition plus optional
 *   trailing comma/period stripped by offsets, never by splitting and
 *   rejoining source). The full wrapper including comma/space is kept as
 *   the span so the host can validate containment and delete exactly it.
 *   A non-wrapper DESTINATION (bare name) keeps the span text as value;
 *   the host handles authorized focus.
 * CORRECTION -> correction ref; same wrapper derivation as destination.
 *   Name-only corrections keep the span text as value.
 * TASK -> task ref (value echoes the span exactly, host resolves it).
 * PROVIDER -> provider ref (same echo rule).
 * SUBJECT, EXCLUDED -> subject/excluded refs (value echoes the span;
 *   neither ever authorizes a route).
 * MODEL -> proposal.model string (source echo; two distinct names reject).
 * EFFORT -> proposal.effort string (source echo; two distinct names reject).
 * clarify action -> unsupported action (the contract's explicit refusal;
 *   the host always answers it with needs-input). Decline stays eligible
 *   through the ordinary provider plus Director path, never as a dispatch.
 * overflow -> unsupported with empty refs (cut evidence is never presented
 *   as complete; truncated requests never accept).
 * No generative instruction or answer is emitted here; answer stays null.
 *
 * Backward compatibility (concrete, not a second training format): v077
 * sidecar labels stay inspectable. PROJECT maps like a name-only
 * destination, TASK/PROVIDER/MODEL map as above, CONTROL/ROUTING/
 * INSTRUCTION are dropped, and NODE rejects as node-routing. New training
 * never emits those labels.
 *
 * Not carried here: confidence gating, continue/steer rewriting by task
 * state, instruction gap policing, catalog resolution, alias learning.
 * The host owns validation, ambiguity, dispatch, and speech. Confidence
 * inputs are accepted and ignored: the contract has no confidence field
 * and they authorize nothing.
 */

const EXTRACTOR_ACTIONS = [
  "start",
  "continue",
  "steer",
  "queue",
  "stop",
  "status",
  "review",
  "reroute",
  "focus-project",
  "focus-task",
  "list-projects",
  "converse",
] as const;

type ExtractorAction = (typeof EXTRACTOR_ACTIONS)[number];

/** Roles-v1 labels plus v077 sidecar labels for inspection only. */
const EXTRACTOR_LABELS = [
  "DESTINATION",
  "TASK",
  "SUBJECT",
  "EXCLUDED",
  "CORRECTION",
  "PROVIDER",
  "MODEL",
  "EFFORT",
  "PROJECT",
  "ROUTING",
  "INSTRUCTION",
  "NODE",
  "CONTROL",
] as const;

type ExtractorLabel = (typeof EXTRACTOR_LABELS)[number];

const PROPOSAL_KEYS = new Set(["text", "action", "actionConfidence", "spans", "overflow"]);
const SPAN_KEYS = new Set(["start", "end", "label", "confidence"]);

export interface ExtractorSpanInput {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly confidence?: number;
}

export interface ExtractorProposalInput {
  readonly text: string;
  readonly action: string;
  readonly actionConfidence?: number;
  readonly spans: ReadonlyArray<ExtractorSpanInput>;
  readonly overflow?: boolean;
}

export type ExtractionAdapterRejectionReason =
  | "malformed"
  | "out-of-bounds"
  | "overlap"
  | "unknown-action"
  | "node-routing"
  | "ambiguous";

export interface ExtractionAdapterRejection {
  readonly status: "rejected";
  readonly reason: ExtractionAdapterRejectionReason;
  readonly prompt: string;
}

export type ExtractionAdapterResult =
  | { readonly status: "proposal"; readonly proposal: CirceSemanticProposal }
  | ExtractionAdapterRejection;

/** Codepoint count of the text. Astral characters count as one. */
export const codePointLength = (text: string): number => Array.from(text).length;

/**
 * Canonical codepoint offset to UTF-16 code-unit offset. Walk the codepoints
 * and accumulate their UTF-16 widths so astral characters contribute 2.
 */
export function codePointToUtf16Offset(text: string, codePointOffset: number): number {
  const chars = Array.from(text);
  let units = 0;
  for (let index = 0; index < codePointOffset; index += 1) {
    units += chars[index]!.length;
  }
  return units;
}

/** Slice by codepoint offsets. Never splits a surrogate pair. */
export const sliceCodePoints = (text: string, start: number, end: number): string =>
  Array.from(text).slice(start, end).join("");

const reject = (
  reason: ExtractionAdapterRejectionReason,
  prompt: string,
): ExtractionAdapterRejection => ({
  status: "rejected",
  reason,
  prompt,
});

const hasUnknownKeys = (value: object, allowed: ReadonlySet<string>): boolean => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return true;
  }
  return false;
};

type ValidSpan = { readonly start: number; readonly end: number; readonly label: ExtractorLabel };

const ROLE_FOR_LABEL: Readonly<Record<ExtractorLabel, SemanticRole | null>> = {
  DESTINATION: "destination",
  TASK: "task",
  SUBJECT: "subject",
  EXCLUDED: "excluded",
  CORRECTION: "correction",
  PROVIDER: "provider",
  MODEL: null,
  EFFORT: null,
  PROJECT: "destination",
  ROUTING: null,
  INSTRUCTION: null,
  NODE: null,
  CONTROL: null,
};

const WRAPPER_PREPOSITIONS = [
  "in",
  "inside",
  "at",
  "within",
  "under",
  "via",
  "through",
  "to",
  "into",
  "toward",
  "towards",
  "using",
] as const;

const WRAPPER_PATTERN = new RegExp(
  `^\\s*(?:${WRAPPER_PREPOSITIONS.join("|")})\\s+(.+?)\\s*[.,;!?]?\\s*$`,
  "iu",
);

/**
 * Derive the named value from a DESTINATION/CORRECTION wrapper without
 * splitting/rejoining source. The regex captures the inner name as one
 * exact substring (offsets preserved); nothing is tokenized or rejoined.
 * Returns the span text unchanged for non-wrappers (bare names), so the
 * host handles authorized focus. Empty inners fall back to the span text
 * so a malformed wrapper never invents an empty authority.
 */
export function deriveWrapperValue(wrapperText: string): string {
  const match = WRAPPER_PATTERN.exec(wrapperText);
  if (match === null || match[1] === undefined) return wrapperText;
  const inner = match[1];
  if (inner.trim().length === 0) return wrapperText;
  return inner;
}

/**
 * Map one extractor proposal onto the semantic proposal contract. Returns a
 * host-validatable proposal, or a rejection the caller turns into typed
 * needs-input. Cardinality (two destinations, two tasks) passes through to
 * the host, which rejects it structurally; this module never picks a side.
 * The emitted proposal is self-decoded against the contract schema before
 * return, so a proposal outcome always satisfies the host's wire shape.
 */
export function adaptExtractionProposal(proposal: unknown): ExtractionAdapterResult {
  if (
    typeof proposal !== "object" ||
    proposal === null ||
    hasUnknownKeys(proposal, PROPOSAL_KEYS)
  ) {
    return reject("malformed", "The extractor returned an unusable proposal. Restate the request.");
  }
  const input = proposal as Record<string, unknown>;
  if (typeof input.text !== "string" || input.text.length === 0) {
    return reject("malformed", "The extractor returned no request text. Restate the request.");
  }
  const text = input.text;
  if (typeof input.action !== "string") {
    return reject("malformed", "The extractor returned no action. Restate the request.");
  }
  if (
    input.action !== "clarify" &&
    !(EXTRACTOR_ACTIONS as ReadonlyArray<string>).includes(input.action)
  ) {
    return reject(
      "unknown-action",
      "The extractor returned an unknown action. Restate the request.",
    );
  }
  const action = input.action === "clarify" ? "unsupported" : (input.action as ExtractorAction);
  if (input.overflow === true) {
    return emit({ action: "unsupported", refs: [], model: null, effort: null, answer: null });
  }
  if (!Array.isArray(input.spans)) {
    return reject("malformed", "The extractor returned no spans. Restate the request.");
  }
  const length = codePointLength(text);
  const valid: ValidSpan[] = [];
  for (const raw of input.spans) {
    if (typeof raw !== "object" || raw === null || hasUnknownKeys(raw, SPAN_KEYS)) {
      return reject(
        "malformed",
        "The extractor returned a span with unknown fields. Restate the request.",
      );
    }
    const span = raw as Record<string, unknown>;
    if (
      typeof span.start !== "number" ||
      typeof span.end !== "number" ||
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end)
    ) {
      return reject(
        "malformed",
        "The extractor returned a span with unusable offsets. Restate the request.",
      );
    }
    if (span.start < 0 || span.end > length || span.start >= span.end) {
      return reject(
        "out-of-bounds",
        "The extractor returned a span outside the request text. Restate the request.",
      );
    }
    if (
      typeof span.label !== "string" ||
      !(EXTRACTOR_LABELS as ReadonlyArray<string>).includes(span.label)
    ) {
      return reject(
        "malformed",
        "The extractor returned a span with an unknown label. Restate the request.",
      );
    }
    valid.push({ start: span.start, end: span.end, label: span.label as ExtractorLabel });
  }
  const ordered = [...valid].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      return reject("overlap", "The extractor returned overlapping spans. Restate the request.");
    }
  }
  if (ordered.some((span) => span.label === "NODE")) {
    return reject(
      "node-routing",
      "Node routing is not available here. Choose a qualified project or task instead.",
    );
  }
  const refs: SemanticRef[] = [];
  let model: string | null = null;
  let effort: string | null = null;
  for (const span of ordered) {
    const utf16Start = codePointToUtf16Offset(text, span.start);
    const utf16End = codePointToUtf16Offset(text, span.end);
    const slice = text.slice(utf16Start, utf16End);
    if (slice !== sliceCodePoints(text, span.start, span.end)) {
      return reject(
        "malformed",
        "The extractor span failed codepoint conversion. Restate the request.",
      );
    }
    if (span.label === "MODEL") {
      // The host model field is one string, so two distinct model names
      // cannot pass through. Ask instead of picking one.
      if (model !== null && model !== slice) {
        return reject("ambiguous", "More than one model was labeled. Which one did you mean?");
      }
      model = slice;
      continue;
    }
    if (span.label === "EFFORT") {
      // Same single-string rule as model: two distinct efforts ask.
      if (effort !== null && effort !== slice) {
        return reject("ambiguous", "More than one effort was labeled. Which one did you mean?");
      }
      effort = slice;
      continue;
    }
    const role = ROLE_FOR_LABEL[span.label];
    if (role === null) continue;
    if (span.label === "DESTINATION" || span.label === "CORRECTION") {
      // Full wrapper stays as the span (comma/space included) so the host
      // can validate containment and delete exactly it. The value is the
      // bounded inner name; bare names fall back to the span text.
      const value = deriveWrapperValue(slice);
      refs.push({ span: { start: utf16Start, end: utf16End, text: slice }, role, value });
      continue;
    }
    refs.push({ span: { start: utf16Start, end: utf16End, text: slice }, role, value: slice });
  }
  return emit({ action, refs, model, effort, answer: null });
}

const emit = (proposal: CirceSemanticProposal): ExtractionAdapterResult => {
  try {
    decodeCirceSemanticProposal(proposal);
  } catch {
    return reject(
      "malformed",
      "The extractor proposal failed contract shape validation. Restate the request.",
    );
  }
  return { status: "proposal", proposal };
};
