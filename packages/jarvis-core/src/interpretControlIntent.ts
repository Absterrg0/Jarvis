export type JarvisControlIntent =
  | { readonly action: "new-task"; readonly instruction: string }
  | { readonly action: "steer"; readonly instruction: string }
  | { readonly action: "queue"; readonly instruction: string }
  | {
      readonly action: "replace-provider";
      readonly target: JarvisTaskTarget;
      /** Provider/model phrase after the replacement verb, e.g. "Claude". */
      readonly provider: string;
    }
  | { readonly action: "interrupt" }
  | { readonly action: "status" }
  | { readonly action: "reroute" }
  | { readonly action: "list-projects" }
  | { readonly action: "focus-project" };

export type JarvisTaskTarget =
  | { readonly kind: "ordinal"; readonly index: number; readonly label: string }
  | { readonly kind: "named"; readonly query: string };

const politeLead = /^(?:jarvis[,.]?\s*)?(?:(?:hey|okay|ok|please)\s+)*(?:oh\s+)?/iu;

function usefulInstruction(utterance: string, prefix: RegExp): string {
  return utterance
    .replace(politeLead, "")
    .replace(prefix, "")
    .replace(/^[,.:;\s-]+/u, "")
    .replace(/^(?:(?:can|could|would|will)\s+you\s+)?please\s+/iu, "")
    .trim();
}

function taskTarget(value: string): JarvisTaskTarget | null {
  const trimmed = value.trim().replace(/^the\s+/iu, "");
  const ordinal = new Map([
    ["first", 0],
    ["first one", 0],
    ["one", 0],
    ["1", 0],
    ["second", 1],
    ["second one", 1],
    ["two", 1],
    ["2", 1],
    ["third", 2],
    ["third one", 2],
    ["three", 2],
    ["3", 2],
    ["fourth", 3],
    ["fourth one", 3],
    ["four", 3],
    ["4", 3],
    ["fifth", 4],
    ["fifth one", 4],
    ["five", 4],
    ["5", 4],
  ]);
  const ordinalIndex = ordinal.get(trimmed.toLowerCase());
  if (ordinalIndex !== undefined) {
    return { kind: "ordinal", index: ordinalIndex, label: trimmed };
  }
  const numbered = trimmed.match(/^(?:task|run|conversation|thread)\s+(\d+)$/iu);
  if (numbered !== null) {
    const index = Number(numbered[1]) - 1;
    return index >= 0 ? { kind: "ordinal", index, label: trimmed } : null;
  }
  const namedNumber = trimmed.match(
    /^(?:task|run|conversation|thread)\s+(one|two|three|four|five)$/iu,
  );
  if (namedNumber !== null) {
    const index = new Map([
      ["one", 0],
      ["two", 1],
      ["three", 2],
      ["four", 3],
      ["five", 4],
    ]).get(namedNumber[1]!.toLowerCase());
    return index === undefined ? null : { kind: "ordinal", index, label: trimmed };
  }
  return trimmed.length === 0 ? null : { kind: "named", query: trimmed };
}

function providerReplacement(utterance: string): JarvisControlIntent | null {
  const normalized = utterance.replace(politeLead, "").trim();
  const replaceMatch = normalized.match(
    /^(?:replace|switch|change)\s+(?:the\s+)?(.+?)\s+(?:task|run|conversation|thread)\s+(?:with|to)\s+(.+?)(?:\s+instead)?[.!?]*$/iu,
  );
  const numberedReplaceMatch = normalized.match(
    /^(?:replace|switch|change)\s+(?:the\s+)?((?:task|run|conversation|thread)\s+(?:one|two|three|four|five|\d+))\s+(?:with|to)\s+(.+?)(?:\s+instead)?[.!?]*$/iu,
  );
  const stopMatch = normalized.match(
    /^(?:stop|cancel|interrupt|halt)\s+(?:the\s+)?(.+?)\s+(?:task|run|conversation|thread)\s+and\s+use\s+(.+?)(?:\s+instead)?[.!?]*$/iu,
  );
  const useMatch = normalized.match(
    /^(?:actually\s+)?use\s+(.+?)\s+for\s+(?:the\s+)?(.+?)\s+(?:task|run|conversation|thread)[.!?]*$/iu,
  );
  const numberedStopMatch = normalized.match(
    /^(?:stop|cancel|interrupt|halt)\s+(?:the\s+)?((?:task|run|conversation|thread)\s+(?:one|two|three|four|five|\d+))\s+and\s+use\s+(.+?)(?:\s+instead)?[.!?]*$/iu,
  );
  const match = replaceMatch ?? numberedReplaceMatch ?? stopMatch ?? numberedStopMatch ?? useMatch;
  if (match === null) return null;
  const isUseForm = useMatch === match;
  const targetValue = isUseForm ? match[2] : match[1];
  const providerValue = isUseForm ? match[1] : match[2];
  const target = taskTarget(targetValue ?? "");
  const provider =
    providerValue
      ?.trim()
      .replace(/\s+instead$/iu, "")
      .trim() ?? "";
  if (target === null || provider.length === 0) return null;
  return { action: "replace-provider", target, provider };
}

/**
 * Converts common conversational control language into a closed action set.
 * It intentionally returns new-task for anything outside the controlled
 * grammar: context and safety validation happen before that task is executed.
 */
export function interpretControlIntent(utterance: string): JarvisControlIntent {
  const text = utterance.trim();
  const normalized = text.replace(politeLead, "");

  const replacement = providerReplacement(text);
  if (replacement !== null) return replacement;

  if (
    /\b(?:what|which)\s+projects?\s+(?:are\s+)?(?:there|available)\b|\b(?:list|show)\s+(?:me\s+)?(?:the\s+)?(?:available\s+)?projects?\b|\b(?:tell\s+me|do\s+I\s+have)\b[\s\S]*\bprojects?\b/iu.test(
      normalized,
    )
  ) {
    return { action: "list-projects" };
  }

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
  const taskFollowupPrefix =
    /^(?:(?:in|on|for)\s+)?(?:that|the\s+(?:same|current|last|previous))\s+(?:(?!(?:request|task|thread|conversation|run)\b)[\p{L}\p{N}'’-]+\s+){0,4}(?:request|task|thread|conversation|run)\b/iu;
  const matchedQueuePrefix = queuePrefix.test(normalized)
    ? queuePrefix
    : taskFollowupPrefix.test(normalized)
      ? taskFollowupPrefix
      : undefined;
  if (matchedQueuePrefix !== undefined) {
    const instruction = usefulInstruction(text, matchedQueuePrefix);
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
