import { interpretControlIntent } from "./interpretControlIntent.ts";

export type FocusedJarvisTask = {
  readonly threadId: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly objective: string;
  readonly state: "running" | "ready" | "failed" | "interrupted";
  readonly activeTurnId?: string;
  readonly waitingFor?: "approval" | "input";
  readonly queuedFollowUps?: number;
};

export type JarvisControlPlan =
  | { readonly action: "new-task"; readonly instruction: string }
  | { readonly action: "steer"; readonly threadId: string; readonly instruction: string }
  | { readonly action: "queue"; readonly threadId: string; readonly instruction: string }
  | { readonly action: "interrupt"; readonly threadId: string; readonly turnId?: string }
  | {
      readonly action: "reroute";
      readonly sourceThreadId: string;
      readonly targetProjectId: string;
      readonly objective: string;
      readonly interrupt?: { readonly threadId: string; readonly turnId?: string };
    }
  | { readonly action: "status"; readonly threadId: string; readonly message: string }
  | { readonly action: "focus-project"; readonly projectId: string }
  | { readonly action: "needs-focus"; readonly prompt: string };

function statusMessage(task: FocusedJarvisTask): string {
  if (task.waitingFor === "approval") {
    return `${task.threadTitle} is waiting for your approval in ${task.projectTitle}.`;
  }
  if (task.waitingFor === "input") {
    return `${task.threadTitle} needs your input in ${task.projectTitle}.`;
  }
  const queueSuffix =
    task.queuedFollowUps && task.queuedFollowUps > 0
      ? ` ${task.queuedFollowUps} follow-up${task.queuedFollowUps === 1 ? " is" : "s are"} queued.`
      : "";
  switch (task.state) {
    case "running":
      return `${task.threadTitle} is still running in ${task.projectTitle}.${queueSuffix}`;
    case "ready":
      return `${task.threadTitle} has finished in ${task.projectTitle}.`;
    case "failed":
      return `${task.threadTitle} failed in ${task.projectTitle}.`;
    case "interrupted":
      return `${task.threadTitle} was stopped in ${task.projectTitle}.`;
  }
}

export function planControlIntent(input: {
  readonly utterance: string;
  readonly targetProjectId: string;
  readonly focused?: FocusedJarvisTask;
}): JarvisControlPlan {
  const intent = interpretControlIntent(input.utterance);
  if (intent.action === "new-task") return intent;
  if (intent.action === "focus-project") {
    return { action: "focus-project", projectId: input.targetProjectId };
  }
  const focused = input.focused;
  if (focused === undefined) {
    return { action: "needs-focus", prompt: "I don't have a recent Jarvis task to apply that to." };
  }
  switch (intent.action) {
    case "steer":
      return { action: "steer", threadId: focused.threadId, instruction: intent.instruction };
    case "queue":
      return { action: "queue", threadId: focused.threadId, instruction: intent.instruction };
    case "interrupt":
      return {
        action: "interrupt",
        threadId: focused.threadId,
        ...(focused.activeTurnId === undefined ? {} : { turnId: focused.activeTurnId }),
      };
    case "status":
      return { action: "status", threadId: focused.threadId, message: statusMessage(focused) };
    case "reroute":
      return {
        action: "reroute",
        sourceThreadId: focused.threadId,
        targetProjectId: input.targetProjectId,
        objective: focused.objective,
        ...(focused.state !== "running"
          ? {}
          : {
              interrupt: {
                threadId: focused.threadId,
                ...(focused.activeTurnId === undefined ? {} : { turnId: focused.activeTurnId }),
              },
            }),
      };
  }
}
