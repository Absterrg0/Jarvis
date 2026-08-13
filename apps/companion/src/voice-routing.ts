import type { CompanionConversationMode } from "./settings.ts";

export type CompanionAttentionTarget = {
  readonly projectId: string;
  readonly threadId: string;
};

/** Explicit worker/provider phrasing starts independent work even in continuation mode. */
export function explicitlyStartsNewCompanionTask(transcript: string): boolean {
  return /\b(?:use|with|through|spin\s+up)\s+(?:the\s+)?(?:codex|claude(?:\s+code)?|cursor|grok|open\s*code)\b/iu.test(
    transcript,
  );
}

export function companionContinuationTarget(input: {
  readonly conversationMode: CompanionConversationMode;
  readonly transcript: string;
  readonly attentionTarget?: CompanionAttentionTarget;
}): CompanionAttentionTarget | undefined {
  return input.conversationMode === "continue-last-thread" &&
    !explicitlyStartsNewCompanionTask(input.transcript)
    ? input.attentionTarget
    : undefined;
}
