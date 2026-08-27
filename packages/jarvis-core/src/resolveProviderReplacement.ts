import type { JarvisTaskDeskTask } from "@t3tools/contracts";

import type { JarvisTaskTarget } from "./interpretControlIntent.ts";

export type ReplacementTask = JarvisTaskDeskTask & {
  /** Projected creation time. Legacy desk entries may not have one. */
  readonly createdAt?: string;
};

export type ProviderReplacementResolution =
  | { readonly status: "resolved"; readonly task: ReplacementTask }
  | {
      readonly status: "needs-input";
      readonly prompt: string;
      readonly choices: ReadonlyArray<string>;
    };

const normalized = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();

function searchableText(task: ReplacementTask): string {
  return normalized([task.title, task.objective, ...task.voiceAliases].join(" "));
}

function choiceLabels(tasks: ReadonlyArray<ReplacementTask>): ReadonlyArray<string> {
  return tasks.map(
    (task, index) => `${index + 1}. ${task.title} — ${task.state}: ${task.objective}`,
  );
}

/**
 * Resolve a replacement target from the desk's known tasks.
 *
 * Ordinals deliberately use projected creation order, never the desk's MRU
 * order. A legacy record without a creation timestamp is not safe to number,
 * so it asks for a named task instead of guessing.
 */
export function resolveProviderReplacementTarget(input: {
  readonly target: JarvisTaskTarget;
  readonly tasks: ReadonlyArray<ReplacementTask>;
}): ProviderReplacementResolution {
  const tasks = input.tasks;
  if (input.target.kind === "ordinal") {
    if (tasks.some((task) => task.createdAt === undefined)) {
      return {
        status: "needs-input",
        prompt: "I can't safely number these tasks yet. Please name the task to replace.",
        choices: choiceLabels(tasks.slice(0, 5)),
      };
    }
    const ordered = [...tasks].sort((left, right) => {
      const time = left.createdAt!.localeCompare(right.createdAt!);
      return time;
    });
    if (new Set(ordered.map((task) => task.createdAt)).size !== ordered.length) {
      return {
        status: "needs-input",
        prompt: "Those tasks were created at the same time. Please name the task to replace.",
        choices: choiceLabels(ordered.slice(0, 5)),
      };
    }
    const task = ordered[input.target.index];
    return task === undefined
      ? {
          status: "needs-input",
          prompt: `There is no ${input.target.label} task in recent history. Please name the task to replace.`,
          choices: choiceLabels(ordered.slice(0, 5)),
        }
      : { status: "resolved", task };
  }

  const queryTokens = normalized(input.target.query).split(" ").filter(Boolean);
  if (queryTokens.length === 0) {
    return {
      status: "needs-input",
      prompt: "Please name the task to replace.",
      choices: choiceLabels(tasks.slice(0, 5)),
    };
  }
  const candidates = tasks.filter((task) => {
    const searchableTokens = new Set(searchableText(task).split(" "));
    return queryTokens.every((token) => searchableTokens.has(token));
  });
  if (candidates.length === 1) return { status: "resolved", task: candidates[0]! };
  if (candidates.length === 0) {
    return {
      status: "needs-input",
      prompt: `I couldn't find a recent task matching “${input.target.query}”.`,
      choices: choiceLabels(tasks.slice(0, 5)),
    };
  }
  const bounded = candidates.slice(0, 5);
  return {
    status: "needs-input",
    prompt: `I found more than one task matching “${input.target.query}”. Which one did you mean?`,
    choices: choiceLabels(bounded),
  };
}
