import {
  JarvisReviewSourceActivityPayload,
  JarvisTaskCreatedActivityPayload,
  type JarvisOutcomeBriefing,
  type MessageId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type Section =
  | "outcome"
  | "findings"
  | "changes"
  | "verification"
  | "limitations"
  | "next-actions"
  | "other";

const isTaskCreatedPayload = Schema.is(JarvisTaskCreatedActivityPayload);
const isReviewSourcePayload = Schema.is(JarvisReviewSourceActivityPayload);

function cleanSentence(value: string): string {
  return value
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(
      /^\s*(?:outcome|summary|result|findings?|verification|tests?|limitations?|remaining|next actions?|next steps?)\s*:\s*/iu,
      "",
    )
    .replace(/[`#*_[\]>()]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.!?;:])/gu, "$1")
    .trim();
}

function sectionForHeading(line: string): Section | undefined {
  const heading = line
    .replace(/^\s*#{1,6}\s*/u, "")
    .replace(/:\s*$/u, "")
    .trim();
  if (/^(?:outcome|summary|result)$/iu.test(heading)) return "outcome";
  if (/^(?:important findings?|findings?)$/iu.test(heading)) return "findings";
  if (/^(?:changes?|changes made|what changed)$/iu.test(heading)) return "changes";
  if (/^(?:verification|tests?|checks?)$/iu.test(heading)) return "verification";
  if (/^(?:limitations?|remaining|caveats?)$/iu.test(heading)) return "limitations";
  if (/^(?:next actions?|next steps?|follow-?ups?)$/iu.test(heading)) return "next-actions";
  if (/^\s*#{1,6}\s+/u.test(line) || /:\s*$/u.test(line)) return "other";
  return undefined;
}

function isTechnicalDetail(sentence: string): boolean {
  return (
    /(?:^|\s)(?:apps|packages|src)\/[\w./-]+/u.test(sentence) ||
    /\b(?:file|module|class|function)\s+['\w./-]+\s+(?:now|was|has)\b/iu.test(sentence)
  );
}

function isVerification(sentence: string): boolean {
  return (
    /\b(?:tests?|typecheck|type check|lint|build|verif(?:y|ied)|checks?)\b/iu.test(sentence) &&
    /\b(?:pass(?:ed)?|green|succeed(?:ed)?|complete(?:d)?|verified|ran|run)\b/iu.test(sentence)
  );
}

function isLimitation(sentence: string): boolean {
  return /\b(?:remaining|limitation|could not|couldn't|unable to|not run|not tested|failed to|unavailable|blocked)\b/iu.test(
    sentence,
  );
}

function isNextAction(sentence: string): boolean {
  return (
    /^(?:next|follow-?up)\b/iu.test(sentence) ||
    /\b(?:would you like|do you want me|shall i|you can|consider)\b/iu.test(sentence)
  );
}

function conversationalize(sentence: string): string {
  const replacements: ReadonlyArray<readonly [RegExp, string]> = [
    [/^Implemented\b/iu, "I've implemented"],
    [/^Fixed\b/iu, "I've fixed"],
    [/^Added\b/iu, "I've added"],
    [/^Updated\b/iu, "I've updated"],
    [/^Completed\b/iu, "I've completed"],
  ];
  const replacement = replacements.find(([pattern]) => pattern.test(sentence));
  return replacement ? sentence.replace(replacement[0], replacement[1]) : sentence;
}

function uniqueBounded(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values.filter(Boolean))].slice(0, 3);
}

function concise(value: string, maximum: number): string {
  const normalized = cleanSentence(value);
  if (normalized.length <= maximum) return normalized;
  const sentenceEnd = normalized.lastIndexOf(". ", maximum - 1);
  return `${normalized.slice(0, sentenceEnd > 120 ? sentenceEnd + 1 : maximum - 1).trim()}…`;
}

function originalGoal(thread: OrchestrationThread, completedAt: string): string {
  const created = thread.activities.findLast(
    (activity) => activity.kind === "jarvis.task.created" && isTaskCreatedPayload(activity.payload),
  );
  if (created !== undefined && isTaskCreatedPayload(created.payload)) {
    return concise(created.payload.objective, 1_000);
  }
  const review = thread.activities.findLast(
    (activity) =>
      activity.kind === "jarvis.review.source" && isReviewSourcePayload(activity.payload),
  );
  if (review !== undefined && isReviewSourcePayload(review.payload)) {
    return concise(review.payload.objective, 1_000);
  }
  const message = thread.messages.findLast(
    (candidate) => candidate.role === "user" && candidate.createdAt <= completedAt,
  );
  return concise(message?.text ?? thread.title, 1_000);
}

/** Projects bounded, speakable facts while leaving the provider result untouched in T3. */
export function buildOutcomeBriefing(input: {
  readonly thread: OrchestrationThread;
  readonly messageId: MessageId;
  readonly result: string;
  readonly completedAt: string;
}): JarvisOutcomeBriefing {
  let section: Section = "outcome";
  let inCode = false;
  const outcome: Array<string> = [];
  const findings: Array<string> = [];
  const changeDetails: Array<string> = [];
  const verification: Array<string> = [];
  const limitations: Array<string> = [];
  const nextActions: Array<string> = [];

  for (const rawLine of input.result.split(/\r?\n/u)) {
    if (/^\s*```/u.test(rawLine)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = sectionForHeading(rawLine);
    if (heading !== undefined) {
      section = heading;
      continue;
    }
    if (isTechnicalDetail(cleanSentence(rawLine))) continue;
    const listItem = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(rawLine);
    const sentences = rawLine.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [];
    const lineOutcome: Array<string> = [];
    for (const rawSentence of sentences) {
      const sentence = cleanSentence(rawSentence);
      if (
        sentence.length === 0 ||
        /^(?:done|finished|completed|all set|task complete|review complete)[.!]?$/iu.test(sentence)
      ) {
        continue;
      }
      if (isTechnicalDetail(sentence)) continue;
      if (section === "next-actions" || isNextAction(sentence)) nextActions.push(sentence);
      else if (section === "limitations" || isLimitation(sentence)) limitations.push(sentence);
      else if (section === "verification" || isVerification(sentence)) verification.push(sentence);
      else if (section === "findings") findings.push(sentence);
      else if (section === "changes") changeDetails.push(sentence);
      else if (section === "outcome" && !listItem) lineOutcome.push(sentence);
    }
    if (outcome.length < 2) outcome.push(...lineOutcome.slice(0, 2 - outcome.length));
  }

  const boundedFindings = uniqueBounded(findings);
  const boundedChangeDetails = uniqueBounded(changeDetails);
  const outcomeFromFinding = outcome.length === 0 && boundedFindings[0] !== undefined;
  const outcomeFromChange =
    outcome.length === 0 &&
    boundedFindings[0] === undefined &&
    boundedChangeDetails[0] !== undefined;
  const outcomeText = conversationalize(
    concise(
      outcome.length > 0
        ? outcome.slice(0, 2).join(" ")
        : boundedFindings[0] !== undefined
          ? boundedFindings[0]
          : boundedChangeDetails[0] !== undefined
            ? boundedChangeDetails[0]
            : "I've finished the task. The full result is waiting in T3.",
      1_000,
    ),
  );
  const boundedVerification = uniqueBounded(verification);
  const boundedLimitations = uniqueBounded(limitations);
  const boundedNextActions = uniqueBounded(nextActions);
  const checkpoint = input.thread.checkpoints.find(
    (candidate) => candidate.status === "ready" && candidate.assistantMessageId === input.messageId,
  );
  const changes =
    checkpoint === undefined
      ? undefined
      : {
          fileCount: checkpoint.files.length,
          additions: checkpoint.files.reduce((total, file) => total + file.additions, 0),
          deletions: checkpoint.files.reduce((total, file) => total + file.deletions, 0),
        };
  const changeSummary =
    changes === undefined || changes.fileCount === 0
      ? undefined
      : `I changed ${changes.fileCount} ${changes.fileCount === 1 ? "file" : "files"}.`;
  const spokenText = concise(
    [
      ...new Set([
        outcomeText,
        outcomeFromFinding ? undefined : boundedFindings[0],
        changeSummary,
        outcomeFromChange ? undefined : boundedChangeDetails[0],
        boundedVerification[0],
        boundedLimitations[0],
        boundedNextActions[0],
      ]),
    ]
      .filter((value): value is string => value !== undefined)
      .join(" "),
    600,
  );

  return {
    goal: originalGoal(input.thread, input.completedAt),
    outcome: outcomeText,
    findings: boundedFindings,
    ...(changes === undefined ? {} : { changes }),
    changeDetails: boundedChangeDetails,
    verification: boundedVerification,
    limitations: boundedLimitations,
    nextActions: boundedNextActions,
    spokenText,
  };
}
