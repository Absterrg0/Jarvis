import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { isClosedResponseFailure } from "./buildPresentation.ts";

export type PendingJarvisReply =
  | {
      readonly kind: "user-input";
      readonly requestId: string;
      readonly questionIds: ReadonlyArray<string>;
      readonly turnId?: TurnId;
    }
  | { readonly kind: "approval"; readonly requestId: string; readonly turnId?: TurnId };

function normalizeConfirmation(utterance: string): string {
  return (
    utterance
      .normalize("NFKD")
      // Delete apostrophes so contractions stay one token: "don't" becomes
      // "dont", never "don t", which word-boundary matchers cannot see.
      .replace(/['’]/gu, "")
      .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
      .trim()
      .toLocaleLowerCase("en-US")
  );
}

// One shared negation test for both parsers. Positive vocabularies stay per
// parser, but negation must never diverge between them: a negated phrase
// declines before any positive keyword is considered.
const CONFIRMATION_NEGATED =
  /\b(?:no|nope|not|never|cannot|cant|dont|wont|isnt|arent|wasnt|werent|hasnt|havent|hadnt|didnt|doesnt|couldnt|shouldnt|wouldnt|mustnt|neednt|decline|deny|reject|cancel|wrong)\b/u;

/** Parse the short confirmation used after acoustic project grounding. */
export function resolveVoiceConfirmation(utterance: string): "accept" | "decline" | undefined {
  const normalized = normalizeConfirmation(utterance);
  if (CONFIRMATION_NEGATED.test(normalized)) return "decline";
  if (/\b(?:yes|correct|right|accept|go ahead|proceed|that one)\b/u.test(normalized)) {
    return "accept";
  }
  return undefined;
}

// Closed grammar for explicit approval answers. The match is anchored to the
// whole utterance: a positive keyword inside a question ("should I approve
// it?"), a hedge ("maybe allow it"), or a condition ("allow it only if tests
// pass") must not read as consent. Polite wrappers and a leading affirmation
// ("yes, allow it") stay accepted; anything else remains clarification.
const EXPLICIT_APPROVAL_ANSWER =
  /^(?:yes(?: please)?|yeah(?: please)?|yep|yup|sure(?: please)?|ok(?:ay)?(?: please)?|go ahead(?: please)?|proceed(?: please)?|allow(?: it| this| that)?(?: please)?|approve(?:d)?(?: it| this| that)?(?: please)?|accept(?:ed)?(?: it| this| that)?(?: please)?|do it(?: please)?|please (?:allow|approve|proceed|go ahead)|confirmed?|affirmative|yes (?:please )?(?:allow|approve|accept|go ahead|proceed)(?: it| this| that)?)$/u;

// Closed grammar for explicit approval refusals. Anchored like the accept
// side: only a bare verdict, politely wrapped at most, refuses. Broad
// negation phrases ("don't stop task", "do not start over") must never read
// as a refusal, so they stay outside this grammar entirely.
const EXPLICIT_DECLINE_ANSWER =
  /^(?:no(?: please| thanks)?|nope|nah(?: please)?|deny(?: it| this| that)?(?: please)?|denied(?: it| this| that)?|decline(?:d)?(?: it| this| that)?(?: please)?|reject(?:ed)?(?: it| this| that)?(?: please)?|do not (?:allow|approve|proceed|go ahead)(?: it| this| that)?|dont (?:allow|approve|proceed|go ahead)(?: it| this| that)?|not (?:that one|correct|right)|no (?:deny|decline|reject)(?: it| this| that)?(?: please)?)$/u;

/**
 * Read a bare approval verdict without treating anything else as consent or
 * refusal. Returns undefined for questions, hedges, conditions, and any
 * utterance with content beyond the verdict itself ("don't stop task" is not
 * a refusal). Used by the deterministic prepass; classified continuations
 * keep the wider resolveSpokenApprovalDecision alongside their intent.
 */
export function isExplicitSpokenApprovalAnswer(
  utterance: string,
): "accept" | "decline" | undefined {
  if (utterance.includes("?")) return undefined;
  const normalized = normalizeConfirmation(utterance);
  if (EXPLICIT_APPROVAL_ANSWER.test(normalized)) return "accept";
  if (EXPLICIT_DECLINE_ANSWER.test(normalized)) return "decline";
  return undefined;
}

/** Parse an approval answer without treating an ambiguous answer as consent. */
export function resolveSpokenApprovalDecision(utterance: string): "accept" | "decline" | "clarify" {
  const normalized = normalizeConfirmation(utterance);
  // Questions first: a negated question ("shouldn't I approve it?") asks
  // instead of answering, so it must clarify rather than record a refusal.
  // An approval answer never needs a question mark. ASR may add one, but
  // consent must be explicit: "should I approve it?" and "allow it?" stay
  // clarification instead of matching the positive vocabulary below.
  if (utterance.includes("?")) return "clarify";
  if (CONFIRMATION_NEGATED.test(normalized)) return "decline";
  if (EXPLICIT_APPROVAL_ANSWER.test(normalized)) return "accept";
  return "clarify";
}

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : null;
}

export type PendingJarvisReplyState =
  | { readonly status: "none" }
  | { readonly status: "single"; readonly pending: PendingJarvisReply }
  | { readonly status: "ambiguous"; readonly pendings: ReadonlyArray<PendingJarvisReply> };

function closedKey(kind: "approval" | "user-input", requestId: string): string {
  return `${kind}:${requestId}`;
}

/** List every distinct unresolved T3 approval or input request, oldest first. */
export function listPendingJarvisReplies(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingJarvisReply[] {
  const byKey = new Map<string, PendingJarvisReply>();
  for (const activity of activities) {
    const requestId = payloadRecord(activity)?.requestId;
    if (typeof requestId !== "string") continue;
    if (activity.kind === "user-input.resolved") {
      byKey.delete(closedKey("user-input", requestId));
      continue;
    }
    if (activity.kind === "approval.resolved") {
      byKey.delete(closedKey("approval", requestId));
      continue;
    }
    if (isClosedResponseFailure(activity)) {
      if (activity.kind === "provider.user-input.respond.failed") {
        byKey.delete(closedKey("user-input", requestId));
      } else {
        byKey.delete(closedKey("approval", requestId));
      }
      continue;
    }
    if (activity.kind !== "user-input.requested" && activity.kind !== "approval.requested") {
      continue;
    }
    const payload = payloadRecord(activity);
    if (activity.kind === "approval.requested") {
      byKey.set(closedKey("approval", requestId), {
        kind: "approval",
        requestId,
        ...(activity.turnId === null ? {} : { turnId: activity.turnId }),
      });
      continue;
    }
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];
    const questionIds = questions.flatMap((question) => {
      if (typeof question !== "object" || question === null || !("id" in question)) return [];
      return typeof question.id === "string" ? [question.id] : [];
    });
    byKey.set(closedKey("user-input", requestId), {
      kind: "user-input",
      requestId,
      questionIds,
      ...(activity.turnId === null ? {} : { turnId: activity.turnId }),
    });
  }
  return [...byKey.values()];
}

export function getPendingJarvisReplyState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingJarvisReplyState {
  const pendings = listPendingJarvisReplies(activities);
  if (pendings.length === 0) return { status: "none" };
  if (pendings.length === 1) return { status: "single", pending: pendings[0]! };
  return { status: "ambiguous", pendings };
}

/**
 * Check a client-pinned answer against live state. Only the one live pending
 * with the same kind and request id matches: a closed request answered late,
 * or an answer landing after a new request opened, never matches.
 */
export function isExpectedPendingReply(
  state: PendingJarvisReplyState,
  expected: { readonly kind: "approval" | "input"; readonly requestId: string },
): boolean {
  if (state.status !== "single") return false;
  const pending = state.pending;
  const kind = pending.kind === "approval" ? "approval" : "input";
  return kind === expected.kind && pending.requestId === expected.requestId;
}

/**
 * Find the single unresolved T3 approval or input request. Returns null when
 * none waits or when several distinct requests wait; ambiguous callers must
 * use getPendingJarvisReplyState and ask instead of answering one of many.
 */
export function findPendingReply(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingJarvisReply | null {
  const state = getPendingJarvisReplyState(activities);
  return state.status === "single" ? state.pending : null;
}
