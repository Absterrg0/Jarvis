/**
 * Shared pending-clarification transitions. Web voice, mobile text/voice, and
 * desktop capture answer the same pending project/question prompts, so the
 * discard decision lives here instead of behind each client's own gate. An
 * explicit discard exits any clarification type: one-candidate confirmation
 * and multi-candidate clarification alike return to idle. Platform capture
 * and navigation stay outside; callers clear their pending route when this
 * matches and keep the original request identity only while it stays active.
 */
export function isJarvisClarificationDiscard(answer: string): boolean {
  const normalized = answer
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return /^(?:no(?: thanks)?|cancel(?: it| that| this)?|discard(?: it| that| this)?|never ?mind|forget it|stop)$/u.test(
    normalized,
  );
}
