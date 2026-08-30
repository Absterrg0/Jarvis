import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type JarvisPresentationEvent,
} from "@t3tools/contracts";

export function canMountJarvisVoiceReporter(
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
): boolean {
  return (
    session?.authenticated === true &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true
  );
}

function normalizedSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " The code details are waiting in your workspace. ")
    .replace(/[`#*_\]>()]/gu, " ")
    .replace(/\[/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.!?;:])/gu, "$1")
    .trim();
}

function conciseSpeechText(text: string, maximum = 460): string {
  const normalized = normalizedSpeechText(text);
  if (normalized.length <= maximum) return normalized;
  const sentenceEnd = normalized.lastIndexOf(". ", maximum - 1);
  return `${normalized.slice(0, sentenceEnd > 120 ? sentenceEnd + 1 : maximum).trim()}…`;
}

export function spokenPresentationText(event: JarvisPresentationEvent): string {
  const output = conciseSpeechText(event.text);
  switch (event.kind) {
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
      return output.length > 0
        ? output
        : "I've finished the task. The details are waiting in your workspace.";
  }
}

export function presentationStatus(event: JarvisPresentationEvent): {
  readonly state: string;
  readonly detail: string;
  readonly kind: "completed" | "attention" | "error";
} {
  const detail = conciseSpeechText(event.text);
  switch (event.kind) {
    case "completed":
      return { state: "Finished", detail, kind: "completed" };
    case "waiting-for-input":
      return { state: "I need your input", detail, kind: "attention" };
    case "approval-needed":
      return { state: "One quick approval", detail, kind: "attention" };
    case "failed":
      return { state: "I hit a snag", detail, kind: "error" };
  }
}

/** Keep duplicate live frames from speaking twice during one mounted session. */
export function rememberBoundedPresentationId(
  ids: Set<string>,
  presentationId: string,
  limit = 512,
): boolean {
  if (ids.has(presentationId)) return false;
  ids.add(presentationId);
  while (ids.size > limit) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
  return true;
}

export function enqueueJarvisPresentation(
  queue: Promise<void>,
  task: () => Promise<void>,
): Promise<void> {
  return queue.then(task);
}
