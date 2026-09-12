import type { ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { normalizeDestinationPhrase, stripDestinationQuotes } from "./destinationSpan.ts";
import {
  findSourceQuoteSpans,
  isJarvisNegatedSpan,
  sourceSpanOverlapsQuotes,
} from "./destinationSpan.ts";

/**
 * Exact source span cited by the semantic supervisor. Offsets are UTF-16
 * code units into the prepared source utterance, so
 * `source.slice(start, end) === text` must hold byte-for-byte with no
 * trimming. A span proves the model copied text from the source
 * (mechanical copy proof). It says nothing about whether the attached role
 * is correct (intent proof stays with the prompt and the eval corpus).
 */
export const SemanticSourceSpan = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(480)),
});
export type SemanticSourceSpan = typeof SemanticSourceSpan.Type;

/**
 * Typed mention roles. Only destination and correction carry positive
 * target evidence and can authorize a project route. Task names the coded
 * work, provider names the runner, and subject/excluded account for
 * mentions that must never authorize: what the work is about, and what
 * the user ruled out or repaired away from.
 */
export const SemanticRole = Schema.Literals([
  "destination",
  "task",
  "subject",
  "excluded",
  "correction",
  "provider",
]);
export type SemanticRole = typeof SemanticRole.Type;

export const SemanticRef = Schema.Struct({
  span: SemanticSourceSpan,
  role: SemanticRole,
  /**
   * The name as heard in the span. The host requires this to echo the
   * span text (normalized), so a typo or mishearing can never be silently
   * normalized into catalog authority. Established aliases resolve, but
   * only by exact match: phonetic matching never applies to aliases.
   */
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
});
export type SemanticRef = typeof SemanticRef.Type;

export const JarvisSemanticProposalAction = Schema.Literals([
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
  /**
   * Explicit refusal to act as one turn: compounds naming two independent
   * controls, and anything that needs no project or task work beyond a
   * clarification. The host always answers it with needs-input, so the
   * lead fragment of a compound never dispatches.
   */
  "unsupported",
  /**
   * Two or more independent commands in one turn. The host validates every
   * step, then dispatches them in order. Steps never nest.
   */
  "sequence",
]);
export type JarvisSemanticProposalAction = typeof JarvisSemanticProposalAction.Type;

/** A single command inside a multi-command turn. */
export const JarvisSemanticStepAction = Schema.Literals([
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
]);
export type JarvisSemanticStepAction = typeof JarvisSemanticStepAction.Type;

export const JarvisSemanticStep = Schema.Struct({
  action: JarvisSemanticStepAction,
  refs: Schema.Array(SemanticRef),
  model: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  effort: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  answer: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400))),
});
export type JarvisSemanticStep = typeof JarvisSemanticStep.Type;

/**
 * One supervisor inference. The proposal carries no project or task IDs,
 * no dispatch wording, and no spoken acknowledgement: the host resolves
 * every name against bounded catalogs, derives the instruction from the
 * source minus validated destination spans, and composes acceptance
 * speech from the accepted route. Single inference, then host validation.
 */
export const JarvisSemanticProposal = Schema.Struct({
  action: JarvisSemanticProposalAction,
  /**
   * Typed evidence refs. Cardinality is explicit: at most one destination,
   * one correction, one task, and one provider ref per turn. A turn naming
   * two independent tasks or targets is a compound and must use
   * unsupported instead; the host rejects extra refs structurally without
   * reading conjunctions.
   */
  refs: Schema.Array(SemanticRef),
  /** Optional model selection by catalog name, resolved by the host. */
  model: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  /** Optional effort selection by option id or label, resolved by the host. */
  effort: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  /**
   * Spoken-sized answer, present only when action is converse. Carrying the
   * answer in the proposal keeps conversation to one supervisor call.
   */
  answer: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400))),
  /** Ordered independent commands for `sequence`; bounded and never nested. */
  steps: Schema.optional(Schema.Array(JarvisSemanticStep)),
});
export type JarvisSemanticProposal = typeof JarvisSemanticProposal.Type;

export const decodeJarvisSemanticProposal = Schema.decodeUnknownSync(JarvisSemanticProposal);

/** Bounded catalogs the host resolves names against. No IDs cross the model. */
export type SemanticEvidenceProject = {
  readonly id: ProjectId;
  readonly title: string;
  /** Every matchable name: title, basename, repository names, exact aliases. */
  readonly names: ReadonlyArray<string>;
};

export type SemanticEvidenceTask = {
  /** Stable task key (thread id string). Resolved back by the caller. */
  readonly key: string;
  readonly title: string;
  /** Every matchable name: title, objective, voice aliases. */
  readonly names: ReadonlyArray<string>;
};

export type SemanticEvidenceProvider = {
  /** Stable provider key (instance id string). Resolved back by the caller. */
  readonly key: string;
  readonly names: ReadonlyArray<string>;
};

export type SemanticEvidenceCatalogs = {
  readonly projects: ReadonlyArray<SemanticEvidenceProject>;
  readonly tasks: ReadonlyArray<SemanticEvidenceTask>;
  readonly providers: ReadonlyArray<SemanticEvidenceProvider>;
};

export type SemanticValidatedTarget = {
  readonly kind: "project";
  readonly id: ProjectId;
  readonly title: string;
  /** The heard value that resolved, for host prompts. */
  readonly value: string;
};

export type SemanticValidatedTask = {
  readonly kind: "task";
  readonly key: string;
  readonly title: string;
  readonly value: string;
};

export type SemanticValidatedProvider = {
  readonly kind: "provider";
  readonly key: string;
  readonly value: string;
};

export type SemanticValidation =
  | {
      readonly status: "valid";
      /** Destination wrapper spans to delete, sorted and non-overlapping. */
      readonly deletions: ReadonlyArray<{ readonly start: number; readonly end: number }>;
      /** The single positive target claim (destination or correction), if any. */
      readonly target: SemanticValidatedTarget | null;
      readonly task: SemanticValidatedTask | null;
      readonly provider: SemanticValidatedProvider | null;
      /** Project ids named by excluded refs (best effort), for ambient veto. */
      readonly excludedProjectIds: ReadonlyArray<ProjectId>;
    }
  | {
      /** Structurally untrustworthy: bad spans, overlap, or cardinality. */
      readonly status: "malformed";
      readonly kind: "span" | "cardinality";
      readonly reason: string;
    }
  | {
      /** Heard text that matches no bounded catalog entry, named exactly. */
      readonly status: "unknown";
      readonly kind: "project" | "task" | "provider";
      readonly text: string;
    }
  | {
      /** Heard text matching more than one catalog entry. */
      readonly status: "ambiguous";
      readonly kind: "project" | "task" | "provider";
      readonly text: string;
      readonly candidateKeys: ReadonlyArray<string>;
    }
  | {
      /**
       * The value does not echo its own span: the cited text was never
       * spoken that way, so a normalized catalog name must not authorize.
       */
      readonly status: "unheard";
      readonly kind: "project" | "task" | "provider";
      readonly text: string;
      readonly value: string;
      readonly candidateKeys: ReadonlyArray<string>;
    };

const MAX_REFS = 8;
const MAX_DESTINATION_SPAN = 160;

const foldName = (value: string): string =>
  normalizeDestinationPhrase(stripDestinationQuotes(value));

const echoMatches = (spanText: string, value: string): boolean => {
  const heard = foldName(spanText);
  return heard.length > 0 && heard === foldName(value);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const containsName = (wrapperText: string, value: string): boolean => {
  const folded = foldName(wrapperText);
  const name = foldName(value);
  if (folded.length === 0 || name.length === 0) return false;
  return new RegExp(`\\b${name.split(/\s+/u).map(escapeRegExp).join("\\s+")}\\b`, "u").test(folded);
};

function checkSpan(source: string, span: SemanticSourceSpan): string | undefined {
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) {
    return "span offsets must be integers";
  }
  if (span.start < 0 || span.end > source.length || span.end <= span.start) {
    return "span offsets are outside the source utterance";
  }
  // Exact proof, no trim: the cited text must reproduce the source slice
  // byte-for-byte, including case, spacing, and punctuation.
  if (source.slice(span.start, span.end) !== span.text) {
    return "span text does not match the source utterance exactly";
  }
  return undefined;
}

/**
 * Validate one proposal against the source text and bounded catalogs.
 * Structural faults (spans, overlap, cardinality) report malformed;
 * catalog misses report the exact heard text as unknown or ambiguous;
 * values that do not echo their span report unheard. Positive target
 * evidence (destination, correction) resolves to projects; subject and
 * excluded refs never authorize and need no catalog match.
 */
export function validateSemanticProposal(input: {
  readonly source: string;
  readonly refs: ReadonlyArray<SemanticRef>;
  readonly catalogs: SemanticEvidenceCatalogs;
}): SemanticValidation {
  const { source, refs, catalogs } = input;
  if (refs.length > MAX_REFS) {
    return { status: "malformed", kind: "cardinality", reason: "too many evidence refs" };
  }
  for (const [index, ref] of refs.entries()) {
    if (ref.value.trim().length === 0) {
      return { status: "malformed", kind: "span", reason: `ref ${index} names nothing` };
    }
    const fault = checkSpan(source, ref.span);
    if (fault !== undefined) {
      return { status: "malformed", kind: "span", reason: `ref ${index}: ${fault}` };
    }
    if (ref.role === "destination" && ref.span.text.length > MAX_DESTINATION_SPAN) {
      return {
        status: "malformed",
        kind: "span",
        reason: `ref ${index}: destination span too long`,
      };
    }
  }
  const ordered = [...refs].sort((left, right) => left.span.start - right.span.start);
  for (const [index, ref] of ordered.entries()) {
    const previous = ordered[index - 1];
    if (previous !== undefined && ref.span.start < previous.span.end) {
      return { status: "malformed", kind: "span", reason: "evidence spans overlap" };
    }
  }
  const count = (role: SemanticRole): number => refs.filter((ref) => ref.role === role).length;
  const destinations = count("destination");
  const corrections = count("correction");
  if (
    destinations > 1 ||
    corrections > 1 ||
    destinations + corrections > 1 ||
    count("task") > 1 ||
    count("provider") > 1
  ) {
    return {
      status: "malformed",
      kind: "cardinality",
      reason: "one destination, task, and provider per turn",
    };
  }

  const matchProjects = (value: string): ReadonlyArray<SemanticEvidenceProject> => {
    const query = foldName(value);
    if (query.length === 0) return [];
    return catalogs.projects.filter((project) =>
      project.names.some((name) => foldName(name) === query),
    );
  };

  const destination = refs.find((ref) => ref.role === "destination");
  const correction = refs.find((ref) => ref.role === "correction");
  const targetRef = destination ?? correction;
  if (destination !== undefined && !containsName(destination.span.text, destination.value)) {
    // The claimed name was never spoken inside the cited wrapper: a typo
    // or normalization must not authorize, so the host asks instead.
    const candidates = matchProjects(destination.value);
    return {
      status: "unheard",
      kind: "project",
      text: destination.span.text,
      value: destination.value,
      candidateKeys: candidates.map((candidate) => String(candidate.id)),
    };
  }
  if (targetRef !== undefined) {
    if (targetRef.role === "correction" && !echoMatches(targetRef.span.text, targetRef.value)) {
      const candidates = matchProjects(targetRef.value);
      return {
        status: "unheard",
        kind: "project",
        text: targetRef.span.text,
        value: targetRef.value,
        candidateKeys: candidates.map((candidate) => String(candidate.id)),
      };
    }
    const matches = matchProjects(targetRef.value);
    if (matches.length === 0) {
      return { status: "unknown", kind: "project", text: targetRef.value };
    }
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        kind: "project",
        text: targetRef.value,
        candidateKeys: matches.map((candidate) => String(candidate.id)),
      };
    }
    const project = matches[0]!;
    if (targetRef.role === "destination") {
      // A quoted literal or a ruled-out mention never authorizes, even when
      // it names a catalogued project: the grammar cites those as quoted
      // host-conditions or excluded evidence instead. Wrong model proposals
      // citing them as destinations are structurally untrustworthy, so the
      // host refuses instead of routing. Unknown names still report unknown
      // above, so only a would-authorize match reaches this veto.
      const quotes = findSourceQuoteSpans(source);
      if (sourceSpanOverlapsQuotes(targetRef.span.start, targetRef.span.end, quotes)) {
        return {
          status: "malformed",
          kind: "span",
          reason: "quoted evidence never authorizes a route",
        };
      }
      if (isJarvisNegatedSpan(source, targetRef.span.start)) {
        return {
          status: "malformed",
          kind: "span",
          reason: "destination ruled out by negation",
        };
      }
    }
    const taskRef = refs.find((ref) => ref.role === "task");
    const task = taskRef === undefined ? null : resolveTaskRef(taskRef, catalogs.tasks);
    if (task !== null && task.status !== "resolved") return task;
    if (taskRef !== undefined && task !== null) {
      // A quoted task mention never authorizes a control, even when it names
      // catalogued work: unknown names still report unknown above, so only a
      // would-authorize match reaches this veto.
      const quotes = findSourceQuoteSpans(source);
      if (sourceSpanOverlapsQuotes(taskRef.span.start, taskRef.span.end, quotes)) {
        return {
          status: "malformed",
          kind: "span",
          reason: "quoted evidence never authorizes a control",
        };
      }
    }
    const providerRef = refs.find((ref) => ref.role === "provider");
    const provider =
      providerRef === undefined ? null : resolveProviderRef(providerRef, catalogs.providers);
    if (provider !== null && provider.status !== "resolved") return provider;
    return {
      status: "valid",
      deletions:
        destination === undefined
          ? []
          : [{ start: destination.span.start, end: destination.span.end }],
      target: { kind: "project", id: project.id, title: project.title, value: targetRef.value },
      task: task?.value ?? null,
      provider: provider?.value ?? null,
      excludedProjectIds: excludedProjectIds(refs, matchProjects),
    };
  }

  const taskRef = refs.find((ref) => ref.role === "task");
  if (taskRef !== undefined) {
    const task = resolveTaskRef(taskRef, catalogs.tasks);
    if (task.status !== "resolved") return task;
    // A quoted task mention never authorizes a control, even when it names
    // catalogued work: unknown names still report unknown above, so only a
    // would-authorize match reaches this veto.
    const quotes = findSourceQuoteSpans(source);
    if (sourceSpanOverlapsQuotes(taskRef.span.start, taskRef.span.end, quotes)) {
      return {
        status: "malformed",
        kind: "span",
        reason: "quoted evidence never authorizes a control",
      };
    }
    const providerRef = refs.find((ref) => ref.role === "provider");
    const provider =
      providerRef === undefined ? null : resolveProviderRef(providerRef, catalogs.providers);
    if (provider !== null && provider.status !== "resolved") return provider;
    return {
      status: "valid",
      deletions: [],
      target: null,
      task: task.value,
      provider: provider?.value ?? null,
      excludedProjectIds: excludedProjectIds(refs, matchProjects),
    };
  }

  const providerRef = refs.find((ref) => ref.role === "provider");
  if (providerRef !== undefined) {
    const provider = resolveProviderRef(providerRef, catalogs.providers);
    if (provider.status !== "resolved") return provider;
    return {
      status: "valid",
      deletions: [],
      target: null,
      task: null,
      provider: provider.value,
      excludedProjectIds: excludedProjectIds(refs, matchProjects),
    };
  }

  return {
    status: "valid",
    deletions: [],
    target: null,
    task: null,
    provider: null,
    excludedProjectIds: excludedProjectIds(refs, matchProjects),
  };
}

type RefResolution<T> =
  | { readonly status: "resolved"; readonly value: T }
  | Extract<SemanticValidation, { status: "unknown" | "ambiguous" | "unheard" }>;

function resolveTaskRef(
  ref: SemanticRef,
  tasks: ReadonlyArray<SemanticEvidenceTask>,
): RefResolution<SemanticValidatedTask> {
  if (!echoMatches(ref.span.text, ref.value)) {
    const query = foldName(ref.value);
    const candidates =
      query.length === 0
        ? []
        : tasks.filter((task) => task.names.some((name) => foldName(name) === query));
    return {
      status: "unheard",
      kind: "task",
      text: ref.span.text,
      value: ref.value,
      candidateKeys: candidates.map((candidate) => candidate.key),
    };
  }
  const query = foldName(ref.value);
  const matches =
    query.length === 0
      ? []
      : tasks.filter((task) => task.names.some((name) => foldName(name) === query));
  if (matches.length === 0) {
    return { status: "unknown", kind: "task", text: ref.value };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      kind: "task",
      text: ref.value,
      candidateKeys: matches.map((candidate) => candidate.key),
    };
  }
  const task = matches[0]!;
  return {
    status: "resolved",
    value: { kind: "task", key: task.key, title: task.title, value: ref.value },
  };
}

function resolveProviderRef(
  ref: SemanticRef,
  providers: ReadonlyArray<SemanticEvidenceProvider>,
): RefResolution<SemanticValidatedProvider> {
  if (!echoMatches(ref.span.text, ref.value)) {
    const query = foldName(ref.value);
    const candidates =
      query.length === 0
        ? []
        : providers.filter((provider) => provider.names.some((name) => foldName(name) === query));
    return {
      status: "unheard",
      kind: "provider",
      text: ref.span.text,
      value: ref.value,
      candidateKeys: candidates.map((candidate) => candidate.key),
    };
  }
  const query = foldName(ref.value);
  const matches =
    query.length === 0
      ? []
      : providers.filter((provider) => provider.names.some((name) => foldName(name) === query));
  if (matches.length === 0) {
    return { status: "unknown", kind: "provider", text: ref.value };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      kind: "provider",
      text: ref.value,
      candidateKeys: matches.map((candidate) => candidate.key),
    };
  }
  const provider = matches[0]!;
  return { status: "resolved", value: { kind: "provider", key: provider.key, value: ref.value } };
}

function excludedProjectIds(
  refs: ReadonlyArray<SemanticRef>,
  matchProjects: (value: string) => ReadonlyArray<SemanticEvidenceProject>,
): ReadonlyArray<ProjectId> {
  const seen = new Set<string>();
  const ids: Array<ProjectId> = [];
  for (const ref of refs) {
    if (ref.role !== "excluded" || !echoMatches(ref.span.text, ref.value)) continue;
    for (const project of matchProjects(ref.value)) {
      const key = String(project.id);
      if (!seen.has(key)) {
        seen.add(key);
        ids.push(project.id);
      }
    }
  }
  return ids;
}
