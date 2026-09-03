import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

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

/** Parse an approval answer without treating an ambiguous answer as consent. */
export function resolveSpokenApprovalDecision(utterance: string): "accept" | "decline" | "clarify" {
  const normalized = normalizeConfirmation(utterance);
  if (CONFIRMATION_NEGATED.test(normalized)) return "decline";
  if (/\b(?:yes|allow|approve|accept|go\s+ahead|proceed)\b/u.test(normalized)) return "accept";
  return "clarify";
}

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : null;
}

/** Find the newest unresolved T3 approval or input request. */
export function findPendingReply(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingJarvisReply | null {
  const resolved = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "user-input.resolved" && activity.kind !== "approval.resolved") continue;
    const requestId = payloadRecord(activity)?.requestId;
    if (typeof requestId === "string") resolved.add(requestId);
  }

  for (const activity of activities.toReversed()) {
    if (activity.kind !== "user-input.requested" && activity.kind !== "approval.requested") {
      continue;
    }
    const payload = payloadRecord(activity);
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || resolved.has(requestId)) continue;
    if (activity.kind === "approval.requested") {
      return {
        kind: "approval",
        requestId,
        ...(activity.turnId === null ? {} : { turnId: activity.turnId }),
      };
    }
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];
    const questionIds = questions.flatMap((question) => {
      if (typeof question !== "object" || question === null || !("id" in question)) return [];
      return typeof question.id === "string" ? [question.id] : [];
    });
    return {
      kind: "user-input",
      requestId,
      questionIds,
      ...(activity.turnId === null ? {} : { turnId: activity.turnId }),
    };
  }
  return null;
}
