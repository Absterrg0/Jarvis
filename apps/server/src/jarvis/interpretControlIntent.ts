export type JarvisControlIntent =
  | { readonly action: "new-task"; readonly instruction: string }
  | { readonly action: "steer"; readonly instruction: string }
  | { readonly action: "queue"; readonly instruction: string }
  | { readonly action: "interrupt" }
  | { readonly action: "status" }
  | { readonly action: "reroute" }
  | { readonly action: "focus-project" };

const politeLead = /^(?:jarvis[,.]?\s*)?(?:(?:hey|okay|ok|please)\s+)*(?:oh\s+)?/iu;

function usefulInstruction(utterance: string, prefix: RegExp): string {
  return utterance
    .replace(politeLead, "")
    .replace(prefix, "")
    .replace(/^[,.:;\s-]+/u, "")
    .trim();
}

/**
 * Converts common conversational control language into a closed action set.
 * It intentionally returns new-task for anything outside the controlled
 * grammar: context and safety validation happen before that task is executed.
 */
export function interpretControlIntent(utterance: string): JarvisControlIntent {
  const text = utterance.trim();
  const normalized = text.replace(politeLead, "");

  if (
    /^(?:what(?:'s| is) (?:it|that|the (?:agent|task)) (?:doing|working on)|where (?:is|are) (?:it|we)|status(?: update)?|how(?:'s| is) (?:it|that) going)\b/iu.test(
      normalized,
    )
  ) {
    return { action: "status" };
  }
  if (
    /^(?:stop|cancel|interrupt|halt|pause)\b(?:\s+(?:it|that|the (?:task|run|agent)))?/iu.test(
      normalized,
    )
  ) {
    return { action: "interrupt" };
  }
  if (
    /^(?:open|switch|move|go|focus)(?:\s+(?:me|us))?\s+(?:to|on|into)?\s*(?:the\s+)?[\s\S]*\b(?:project|workspace|repo)\b/iu.test(
      normalized,
    )
  ) {
    return { action: "focus-project" };
  }
  if (
    /\b(?:that|the\s+(?:last|previous|same)\s+(?:task|run)|same\s+(?:task|thing))\b[\s\S]*\b(?:in|inside|within|to)\b[\s\S]*\b(?:project|workspace|repo)\b/iu.test(
      normalized,
    ) ||
    /\b(?:run|do|restart|rerun|move)\b[\s\S]*\b(?:that|same|last|previous)\b[\s\S]*\b(?:in|inside|within|to)\b/iu.test(
      normalized,
    )
  ) {
    return { action: "reroute" };
  }

  const queuePrefix =
    /^(?:(?:after|once|when)\s+(?:(?:that|it)(?:'s|\s+is)?\s+)?(?:done|finished|complete|completed)|after\s+that|then|next)\b/iu;
  if (queuePrefix.test(normalized)) {
    const instruction = usefulInstruction(text, queuePrefix);
    return instruction.length > 0
      ? { action: "queue", instruction }
      : { action: "new-task", instruction: text };
  }

  const steerPrefix =
    /^(?:(?:oh\s+)?wait[,.]?\s*)?(?:also|actually|instead|correction|change\s+that\s+to)\b/iu;
  if (steerPrefix.test(normalized) || /^(?:oh\s+)?wait[,.]?\s+/iu.test(normalized)) {
    const withoutWait = normalized.replace(/^(?:oh\s+)?wait[,.]?\s*/iu, "");
    const instruction = usefulInstruction(withoutWait, /^(?:also|actually|instead|correction)\b/iu);
    return instruction.length > 0
      ? { action: "steer", instruction }
      : { action: "new-task", instruction: text };
  }

  return { action: "new-task", instruction: text };
}
