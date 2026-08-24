import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type JarvisVoiceReport,
} from "@t3tools/contracts";

export function enqueueJarvisPresentation(
  queue: Promise<void>,
  task: () => Promise<void>,
): Promise<void> {
  return queue.then(task);
}

export type JarvisDeliveryResult<A> =
  | { readonly status: "succeeded"; readonly value: A; readonly attempts: number }
  | { readonly status: "exhausted"; readonly attempts: number }
  | { readonly status: "cancelled"; readonly attempts: number };

const DEFAULT_DELIVERY_MAX_ATTEMPTS = 3;
const DEFAULT_DELIVERY_MAX_DURATION_MS = 15_000;

export async function retryJarvisDelivery<A>(input: {
  readonly run: (signal: AbortSignal) => Promise<{ readonly _tag: string; readonly value?: A }>;
  readonly isActive: () => boolean;
  readonly wait: (signal: AbortSignal) => Promise<void>;
  readonly accept?: (value: A) => boolean;
  readonly maxAttempts?: number;
  readonly maxDurationMs?: number;
  readonly now?: () => number;
}): Promise<JarvisDeliveryResult<A>> {
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_DELIVERY_MAX_ATTEMPTS));
  const maxDurationMs = Math.max(0, input.maxDurationMs ?? DEFAULT_DELIVERY_MAX_DURATION_MS);
  const now = input.now ?? Date.now;
  const deadline = now() + maxDurationMs;
  let attempts = 0;
  const abortController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDeadline!: () => void;
  const deadlineReached = new Promise<void>((resolve) => {
    resolveDeadline = resolve;
    deadlineTimer = setTimeout(() => {
      abortController.abort();
      resolve();
    }, maxDurationMs);
  });

  const runUntilDeadline = async <T>(
    operation: () => Promise<T>,
  ): Promise<
    | { readonly _tag: "completed"; readonly value: T }
    | { readonly _tag: "failed" }
    | { readonly _tag: "deadline" }
  > => {
    const operationResult = Promise.resolve()
      .then(operation)
      .then(
        (value) => ({ _tag: "completed" as const, value }),
        () => ({ _tag: "failed" as const }),
      );
    const result = await Promise.race([
      operationResult,
      deadlineReached.then(() => ({ _tag: "deadline" as const })),
    ]);
    return result;
  };

  try {
    while (
      input.isActive() &&
      !abortController.signal.aborted &&
      attempts < maxAttempts &&
      now() < deadline
    ) {
      attempts += 1;
      const result = await runUntilDeadline(() => input.run(abortController.signal));
      if (result._tag === "deadline") {
        return input.isActive()
          ? { status: "exhausted", attempts }
          : { status: "cancelled", attempts };
      }
      const delivery = result._tag === "completed" ? result.value : { _tag: "Failure" };
      if (
        delivery._tag === "Success" &&
        (input.accept === undefined || input.accept(delivery.value as A))
      ) {
        return { status: "succeeded", value: delivery.value as A, attempts };
      }
      if (!input.isActive()) return { status: "cancelled", attempts };
      if (abortController.signal.aborted || attempts >= maxAttempts || now() >= deadline) {
        return { status: "exhausted", attempts };
      }
      const waited = await runUntilDeadline(() => input.wait(abortController.signal));
      if (waited._tag === "deadline") {
        return input.isActive()
          ? { status: "exhausted", attempts }
          : { status: "cancelled", attempts };
      }
    }
    return input.isActive() ? { status: "exhausted", attempts } : { status: "cancelled", attempts };
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    resolveDeadline();
    abortController.abort();
  }
}

export function canMountJarvisVoiceReporter(
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
): boolean {
  return (
    session?.authenticated === true &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true
  );
}

export function speakerPriority(input: {
  /** A paired report-only companion relay must win over every host surface. */
  readonly relay?: boolean;
  readonly preferred: boolean;
  readonly mobile: boolean;
  readonly electron: boolean;
}): number {
  // This renderer exists only in the hidden, paired Windows companion. Giving
  // it a distinct tier avoids a nondeterministic tie with the laptop Electron
  // host (both otherwise have the desktop priority of 75).
  if (input.relay) return 200;
  if (input.preferred) return 100;
  if (input.mobile) return 40;
  return input.electron ? 75 : 60;
}

/** Reports originated by another Companion identity stay on that execution node. */
export function isJarvisReportForIdentity(report: JarvisVoiceReport, identity: string): boolean {
  const origin = report.origin?.originInteractionId;
  return origin === undefined || origin === identity;
}

function normalizedSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " The code details are waiting in T3. ")
    .replace(/[`#*_[\]>()]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.!?;:])/gu, "$1")
    .trim();
}

function conversationalizeOutcome(text: string): string {
  const patterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/^Implemented\b/iu, "I've implemented"],
    [/^Fixed\b/iu, "I've fixed"],
    [/^Added\b/iu, "I've added"],
    [/^Updated\b/iu, "I've updated"],
    [/^Completed\b/iu, "I've completed"],
  ];
  const replacement = patterns.find(([pattern]) => pattern.test(text));
  const conversational = replacement ? text.replace(replacement[0], replacement[1]) : text;
  return conversational
    .replace(
      /^Project questions are answered directly from T3's project catalog/iu,
      "Project questions now come directly from your T3 project list",
    )
    .replace(/without starting Codex/giu, "without starting a coding agent");
}

function isGenericCompletion(sentence: string): boolean {
  return /^(?:done|finished|completed|all set|task complete)[.!]?$/iu.test(sentence.trim());
}

function isImplementationDetail(sentence: string): boolean {
  return (
    /(?:^|\s)(?:apps|packages|src)\/[\w./-]+/u.test(sentence) ||
    /\b(?:file|module|class|function)\s+[`'\w./-]+\s+(?:now|was|has)\b/iu.test(sentence)
  );
}

function conversationalizeVerification(sentence: string): string {
  return sentence.replace(/^(\d+)\s+(.+\btests?\s+passed\.)$/iu, "All $1 $2");
}

function completedBriefingText(text: string): string {
  const codeDetail = "The code details are waiting in T3.";
  const sentences = text
    .replace(/```[\s\S]*?```/gu, `\n${codeDetail}\n`)
    .split(/\r?\n/u)
    .flatMap((rawLine) => {
      const markdownHeading = /^\s*#{1,6}\s+/u.test(rawLine);
      const line = rawLine.replace(/^\s*(?:[-*+]\s+|#{1,6}\s*)/u, "").trim();
      const labelHeading = /^[\p{L}\p{N} /&-]+:$/u.test(line);
      const fileLevelDetail = /(?:^|[`\s])(?:apps|packages|src)\/[\w./-]+/u.test(line);
      if (line.length === 0 || markdownHeading || labelHeading || fileLevelDetail) return [];
      return line.match(/[^.!?]+(?:[.!?]+|$)/gu)?.map((sentence) => sentence.trim()) ?? [];
    });
  const outcomeIndex = sentences.findIndex(
    (sentence) =>
      sentence !== codeDetail &&
      !isGenericCompletion(sentence) &&
      !isImplementationDetail(sentence) &&
      !(
        /\b(?:tests?|typecheck|type check|lint|build|verif(?:y|ied))\b/iu.test(sentence) &&
        /\b(?:pass(?:ed)?|green|succeed(?:ed)?|complete(?:d)?|verified)\b/iu.test(sentence)
      ),
  );
  const outcome = conversationalizeOutcome(sentences[outcomeIndex] ?? "");
  const verificationIndex = sentences.findIndex(
    (sentence, index) =>
      index !== outcomeIndex &&
      /\b(?:tests?|typecheck|type check|lint|build|verif(?:y|ied))\b/iu.test(sentence) &&
      /\b(?:pass(?:ed)?|green|succeed(?:ed)?|complete(?:d)?|verified)\b/iu.test(sentence),
  );
  const caveatIndex = sentences.findIndex(
    (sentence, index) =>
      index !== outcomeIndex &&
      index !== verificationIndex &&
      /\b(?:remaining|limitation|could not|couldn't|not run|follow-up|next step)\b/iu.test(
        sentence,
      ),
  );
  const segments = [
    outcome,
    verificationIndex >= 0
      ? conversationalizeVerification(sentences[verificationIndex]!)
      : undefined,
    caveatIndex >= 0 ? sentences[caveatIndex] : undefined,
  ];
  if (sentences.includes(codeDetail)) segments.push(codeDetail);
  const briefing = segments.filter((segment): segment is string => Boolean(segment)).join(" ");
  return conciseSpeechText(briefing, 320);
}

function conciseSpeechText(text: string, maximum = 460): string {
  const normalized = normalizedSpeechText(text);
  if (normalized.length <= maximum) return normalized;
  const sentenceEnd = normalized.lastIndexOf(". ", maximum - 1);
  return `${normalized.slice(0, sentenceEnd > 120 ? sentenceEnd + 1 : maximum).trim()}…`;
}

/**
 * The companion mirrors the spoken state, so an answer, question, or failure
 * is still useful at a glance when the person is away from the laptop.
 */
export function companionReportStatus(report: JarvisVoiceReport): {
  readonly state: string;
  readonly detail: string;
  readonly kind: "completed" | "attention" | "error";
} {
  const detail =
    report.kind === "completed"
      ? (report.briefing?.spokenText ?? completedBriefingText(report.text))
      : conciseSpeechText(report.text);
  switch (report.kind) {
    case "completed":
      return {
        state: "Finished — short version",
        detail,
        kind: "completed",
      };
    case "waiting-for-input":
      return { state: "I need your input", detail, kind: "attention" };
    case "approval-needed":
      return { state: "One quick approval", detail, kind: "attention" };
    case "failed":
      return { state: "I hit a snag", detail, kind: "error" };
  }
}

export function spokenReportText(report: JarvisVoiceReport): string {
  const output =
    report.kind === "completed"
      ? (report.briefing?.spokenText ?? completedBriefingText(report.text))
      : conciseSpeechText(report.text);
  switch (report.kind) {
    case "waiting-for-input":
      return output.length > 0 ? `I need one quick detail. ${output}` : "I need one quick detail.";
    case "approval-needed":
      return output.length > 0
        ? `Quick check before I continue. ${output}`
        : "Quick check before I continue.";
    case "failed":
      return output.length > 0
        ? `I hit a snag. ${output}`
        : "I hit a snag. I am waiting for your direction.";
    case "completed":
      return output.length > 0 ? output : "I've finished the task. The details are waiting in T3.";
  }
}
