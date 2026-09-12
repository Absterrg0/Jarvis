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
  return /^(?:no(?: thanks)?|cancel(?: it| that| this)?|discard(?: it| that| this)?|never ?mind|forget it|stop|start over|start again|restart|not that one|not this one|neither)$/u.test(
    normalized,
  );
}

/**
 * Words that carry no request content when they survive a matched target
 * mention. "I meant Rivvl" and "use the Rivvl project" are target answers;
 * "check pull requests in Rivvl" still owns a command after the name is
 * removed. Only the second form may retire the paused request.
 */
const CLARIFICATION_ANSWER_FILLER: ReadonlySet<string> = new Set([
  "a",
  "about",
  "actually",
  "all",
  "alright",
  "an",
  "and",
  "are",
  "at",
  "can",
  "choose",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "go",
  "hello",
  "hey",
  "hi",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "just",
  "me",
  "mean",
  "meant",
  "my",
  "number",
  "of",
  "ok",
  "okay",
  "on",
  "one",
  "option",
  "or",
  "pick",
  "please",
  "project",
  "repo",
  "repository",
  "right",
  "said",
  "say",
  "select",
  "so",
  "switch",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "use",
  "using",
  "want",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "workspace",
  "would",
  "you",
]);

const foldClarificationAnswer = (value: string): string =>
  value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Whether an answer that matched a target still carries its own command.
 * The caller passes the exact text the target matcher consumed, so a project
 * name inside a longer sentence cannot launder the rest of that sentence into
 * a stale request. Any surviving content means the user stated a new request
 * and the paused instruction must not run under the new target.
 */
export function jarvisClarificationAnswerHasCommandRemainder(input: {
  readonly answer: string;
  readonly matchedText: string;
}): boolean {
  const answer = foldClarificationAnswer(input.answer);
  const matched = foldClarificationAnswer(input.matchedText);
  if (matched.length === 0) return true;
  const index = answer.indexOf(matched);
  const remainder =
    index === -1 ? answer : `${answer.slice(0, index)} ${answer.slice(index + matched.length)}`;
  return remainder
    .split(" ")
    .some((word) => word.length > 0 && !CLARIFICATION_ANSWER_FILLER.has(word));
}
