import type { JarvisTaskDeskNavigation, JarvisTaskDeskTask } from "@t3tools/contracts";

export type TaskDeskNavigationResolution =
  | { readonly status: "not-navigation" }
  | { readonly status: "resolved"; readonly navigation: JarvisTaskDeskNavigation }
  | {
      readonly status: "needs-input";
      readonly prompt: string;
      readonly choices: ReadonlyArray<string>;
      readonly candidates: ReadonlyArray<{
        readonly threadId: JarvisTaskDeskTask["threadId"];
        readonly label: string;
      }>;
    };

const normalized = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

function entityText(utterance: string): string | null {
  const match = utterance.match(
    /^(?:jarvis[,.]?\s*)?(?:switch|focus|go|return|take me)(?:\s+(?:back|over))?\s+(?:to|on)\s+(.+?)\s+(?:task|conversation|thread)$/iu,
  );
  return match?.[1]?.trim() ?? null;
}

function searchableText(task: JarvisTaskDeskTask): string {
  return normalized([task.title, task.objective, task.state, ...task.voiceAliases].join(" "));
}

const choiceLabels = (tasks: ReadonlyArray<JarvisTaskDeskTask>) =>
  tasks.map((task, index) => `${index + 1}. ${task.title} — ${task.state}: ${task.objective}`);

export function resolveTaskDeskNavigation(input: {
  readonly utterance: string;
  readonly tasks: ReadonlyArray<JarvisTaskDeskTask>;
}): TaskDeskNavigationResolution {
  const utterance = normalized(input.utterance.replace(/^jarvis[,.]?\s*/iu, ""));
  if (/^(?:go |move )?back$/u.test(utterance) || utterance === "previous task") {
    return { status: "resolved", navigation: { action: "back" } };
  }
  if (/^(?:go |move )?forward$/u.test(utterance) || utterance === "next task") {
    return { status: "resolved", navigation: { action: "forward" } };
  }
  if (
    /^(?:start|open|create)(?: an?| the)? (?:new|another|separate|independent) conversation$/u.test(
      utterance,
    )
  ) {
    return { status: "resolved", navigation: { action: "new-conversation" } };
  }
  if (/^(?:cancel|stay here|never mind)(?: the)? new conversation$/u.test(utterance)) {
    return { status: "resolved", navigation: { action: "cancel-new-conversation" } };
  }

  const requestedEntity = entityText(input.utterance);
  if (requestedEntity === null) return { status: "not-navigation" };
  if (/\b(?:project|workspace|repo|repository)\b/iu.test(requestedEntity)) {
    return { status: "not-navigation" };
  }
  const query = normalized(requestedEntity);
  if (query.length === 0) return { status: "not-navigation" };
  const queryTokens = query.split(" ");
  const candidates = input.tasks.filter((task) => {
    const searchableTokens = new Set(searchableText(task).split(" "));
    return queryTokens.every((token) => searchableTokens.has(token));
  });
  if (candidates.length === 1) {
    return {
      status: "resolved",
      navigation: { action: "focus", threadId: candidates[0]!.threadId },
    };
  }
  if (candidates.length === 0) {
    const fallback = input.tasks.slice(0, 5);
    return {
      status: "needs-input",
      prompt: `I couldn't find a recent task matching “${requestedEntity}”.`,
      choices: choiceLabels(fallback),
      candidates: fallback.map((task, index) => ({
        threadId: task.threadId,
        label: choiceLabels(fallback)[index]!,
      })),
    };
  }
  const ambiguous = candidates.slice(0, 5);
  return {
    status: "needs-input",
    prompt: `I found more than one task matching “${requestedEntity}”. Which one did you mean?`,
    choices: choiceLabels(ambiguous),
    candidates: ambiguous.map((task, index) => ({
      threadId: task.threadId,
      label: choiceLabels(ambiguous)[index]!,
    })),
  };
}
