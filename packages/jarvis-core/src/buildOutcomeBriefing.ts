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
    .replace(/[`#*[\]>()]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.!?;:])/gu, "$1")
    .trim();
}

function classificationSentence(value: string): string {
  return value
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/[`#*[\]>()]/gu, " ")
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
  if (/^(?:fixed|implemented|added|updated|changed|removed|resolved)\b/iu.test(heading)) {
    return undefined;
  }
  if (/^\s*#{1,6}\s+/u.test(line) || /:\s*$/u.test(line)) return "other";
  return undefined;
}

function isTechnicalDetail(sentence: string): boolean {
  return (
    /(?:^|\s)(?:apps|packages|src)\/[\w./-]+/u.test(sentence) ||
    /\b(?:file|module|class|function)\s+['\w./-]+\s+(?:now|was|has)\b/iu.test(sentence)
  );
}

function isGenericPreamble(sentence: string): boolean {
  return /^(?:here(?:'s| is) what i found|i (?:completed|finished) (?:a|the|your) task|the full (?:response|result) is (?:in|waiting in) t3)[.!]?$/iu.test(
    sentence,
  );
}

function isVerification(sentence: string): boolean {
  return (
    /\b(?:tests?|typecheck|type check|lint|build|verif(?:y|ied)|checks?|routes?|smoke)\b/iu.test(
      sentence,
    ) &&
    /\b(?:pass(?:ed|es)?|green|succeed(?:ed)?|complete(?:d)?|verified|ran|run|returned?\s+2\d\d)\b/iu.test(
      sentence,
    )
  );
}

function isLimitation(sentence: string): boolean {
  return /\b(?:remaining|limitation|could not|couldn't|unable to|not run|not tested|failed|failure|error|broken|unavailable|blocked|unreachable|returned?\s+[45]\d\d)\b/iu.test(
    sentence,
  );
}

function isChange(sentence: string): boolean {
  return /^(?:fixed|implemented|added|updated|changed|removed|resolved)\b/iu.test(sentence);
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

function normalizeVerification(sentence: string, classification: string): string {
  const countedTests = classification.match(/\btests?\s*:\s*(\d+)\s*\/\s*(\d+)\s+passed\b/iu);
  if (countedTests !== null) {
    const passed = Number(countedTests[1]);
    const total = Number(countedTests[2]);
    return passed === total ? `All ${total} tests passed.` : `${passed} of ${total} tests passed.`;
  }
  return sentence;
}

function withoutFinalPunctuation(value: string): string {
  return value.replace(/[.!?]+$/u, "").trim();
}

function sentenceFromClauses(clauses: ReadonlyArray<string>): string | undefined {
  const values: Array<string> = [];
  for (const clause of clauses) {
    const value = withoutFinalPunctuation(clause);
    if (value.length > 0) values.push(value);
  }
  const [first, ...rest] = values;
  if (first === undefined || first.length === 0) return undefined;
  const capitalized = `${first[0]!.toUpperCase()}${first.slice(1)}`;
  if (rest.length === 0) return `${capitalized}.`;
  if (rest.length === 1) return `${capitalized} and ${rest[0]}.`;
  return `${capitalized}, ${rest.slice(0, -1).join(", ")}, and ${rest.at(-1)}.`;
}

function deploymentVerificationSummary(verification: ReadonlyArray<string>): string | undefined {
  const clauses: Array<string> = [];
  const tests = verification.find((sentence) => /\btests?\b.*\bpassed\b/iu.test(sentence));
  if (tests !== undefined) clauses.push(tests);
  if (verification.some((sentence) => /\bproduction build\b.*\bpass(?:ed)?\b/iu.test(sentence))) {
    clauses.push("the production build passed");
  }
  if (verification.some((sentence) => /\breturned?\s+200\b/iu.test(sentence))) {
    clauses.push("the checked routes returned 200");
  }
  return sentenceFromClauses(clauses.length > 0 ? clauses : verification.slice(0, 1));
}

function isNonBlockingLimitation(sentence: string): boolean {
  return /\bnon-blocking\b/iu.test(sentence) || /\bonly\b.*\bwarnings?\b/iu.test(sentence);
}

function deploymentLimitationSummary(sentence: string): string {
  if (isNonBlockingLimitation(sentence)) return "Only non-blocking warnings remain.";
  return sentence.replace(/^Production build\b/iu, "The production build");
}

function deploymentChangeSummary(sentence: string): string {
  if (/^Fixed\b.*\bTypeScript error\b/iu.test(sentence)) {
    return "I fixed one TypeScript error.";
  }
  return conversationalize(sentence);
}

function deploymentNextAction(sentence: string): string {
  return sentence
    .replace(/\bto production environment\b/iu, "to the production environment")
    .replace(/\s+and redeploy\b/iu, ", then redeploy");
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
    const lineSentence = cleanSentence(rawLine);
    const lineClassification = classificationSentence(rawLine);
    if (listItem && !isTechnicalDetail(lineSentence)) {
      if (section === "next-actions" || isNextAction(lineClassification)) {
        nextActions.push(lineSentence);
        continue;
      }
      if (section === "changes" || isChange(lineClassification)) {
        changeDetails.push(lineSentence);
        continue;
      }
      if (section === "limitations" || isLimitation(lineClassification)) {
        limitations.push(lineSentence);
        continue;
      }
      if (section === "verification" || isVerification(lineClassification)) {
        verification.push(normalizeVerification(lineSentence, lineClassification));
        continue;
      }
    }
    const sentences = rawLine.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [];
    const lineOutcome: Array<string> = [];
    for (const rawSentence of sentences) {
      const sentence = cleanSentence(rawSentence);
      const classification = classificationSentence(rawSentence);
      if (
        sentence.length === 0 ||
        /^(?:done|finished|completed|all set|task complete|review complete)[.!]?$/iu.test(
          sentence,
        ) ||
        isGenericPreamble(sentence)
      ) {
        continue;
      }
      if (isTechnicalDetail(sentence)) continue;
      if (section === "next-actions" || isNextAction(classification)) nextActions.push(sentence);
      else if (section === "changes" || isChange(classification)) changeDetails.push(sentence);
      else if (section === "limitations" || isLimitation(classification))
        limitations.push(sentence);
      else if (section === "verification" || isVerification(classification))
        verification.push(normalizeVerification(sentence, classification));
      else if (section === "findings") findings.push(sentence);
      else if (section === "outcome" && !listItem) lineOutcome.push(sentence);
    }
    if (outcome.length < 2) outcome.push(...lineOutcome.slice(0, 2 - outcome.length));
  }

  const boundedFindings = uniqueBounded(findings);
  const boundedChangeDetails = uniqueBounded(changeDetails);
  const boundedVerification = uniqueBounded(verification);
  const boundedLimitations = uniqueBounded(limitations);
  const boundedNextActions = uniqueBounded(nextActions);
  const goal = originalGoal(input.thread, input.completedAt);
  const deploymentCheck = /\bdeploy(?:ment|ed|ing)?\b/iu.test(goal);
  const blockingDeploymentLimitation = boundedLimitations.find(
    (sentence) => !isNonBlockingLimitation(sentence),
  );
  const deploymentOutcome = deploymentCheck
    ? blockingDeploymentLimitation !== undefined
      ? "Deployment is not working."
      : boundedVerification.length > 0
        ? "Deployment is working."
        : undefined
    : undefined;
  const outcomeFromFinding = outcome.length === 0 && boundedFindings[0] !== undefined;
  const outcomeFromChange =
    outcome.length === 0 &&
    boundedFindings[0] === undefined &&
    boundedChangeDetails[0] !== undefined;
  const clarification =
    outcome.length === 0 &&
    boundedFindings.length === 0 &&
    boundedChangeDetails.length === 0 &&
    boundedVerification.length === 0 &&
    boundedLimitations.length === 0 &&
    boundedNextActions[0]?.endsWith("?")
      ? boundedNextActions[0]
      : undefined;
  const outcomeText =
    deploymentOutcome ??
    clarification ??
    conversationalize(
      concise(
        outcome.length > 0
          ? outcome.slice(0, 2).join(" ")
          : boundedFindings[0] !== undefined
            ? boundedFindings[0]
            : boundedChangeDetails[0] !== undefined
              ? boundedChangeDetails[0]
              : boundedVerification[0] !== undefined
                ? boundedVerification[0]
                : boundedLimitations[0] !== undefined
                  ? boundedLimitations[0]
                  : "The agent did not give a clear answer.",
        1_000,
      ),
    );
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
  const spokenText = concise(
    [
      ...new Set(
        deploymentOutcome !== undefined
          ? [
              outcomeText,
              deploymentVerificationSummary(boundedVerification),
              boundedChangeDetails[0] === undefined
                ? undefined
                : deploymentChangeSummary(boundedChangeDetails[0]),
              boundedLimitations[0] === undefined
                ? undefined
                : deploymentLimitationSummary(boundedLimitations[0]),
              boundedNextActions[0] === undefined
                ? undefined
                : deploymentNextAction(boundedNextActions[0]),
            ]
          : [
              outcomeText,
              outcomeFromFinding ? undefined : boundedFindings[0],
              outcomeFromChange ? undefined : boundedChangeDetails[0],
              boundedVerification[0],
              boundedLimitations[0],
              boundedNextActions[0],
            ],
      ),
    ]
      .filter((value): value is string => value !== undefined)
      .join(" "),
    600,
  );

  return {
    goal,
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
