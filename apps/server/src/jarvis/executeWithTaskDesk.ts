import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { JarvisManagerExecuteInput, JarvisManagerShape } from "./Services/JarvisManager.ts";
import type { JarvisTaskDeskShape } from "./Services/JarvisTaskDesk.ts";
import { resolveTaskDeskNavigation } from "./resolveTaskDeskNavigation.ts";

export const executeWithTaskDesk = Effect.fn("Jarvis.executeWithTaskDesk")(function* (
  manager: JarvisManagerShape,
  taskDesk: JarvisTaskDeskShape,
  sessionId: AuthSessionId,
  input: JarvisManagerExecuteInput,
) {
  const desk = yield* taskDesk.get(sessionId);
  const navigation = resolveTaskDeskNavigation({
    utterance: input.utterance,
    tasks: desk.recentTasks,
  });
  if (navigation.status === "needs-input") {
    return {
      status: "needs-input" as const,
      reason: "control-target-required" as const,
      prompt: navigation.prompt,
      choices: navigation.choices,
    };
  }
  if (navigation.status === "resolved") {
    const nextDesk = yield* taskDesk.navigate({
      sessionId,
      navigation: navigation.navigation,
    });
    const focusedTask = nextDesk.recentTasks.find(
      (task) => task.threadId === nextDesk.focusedThreadId,
    );
    const message =
      navigation.navigation.action === "new-conversation"
        ? "The next instruction will start an independent conversation."
        : navigation.navigation.action === "cancel-new-conversation"
          ? "The next instruction will stay with the current conversation."
          : focusedTask === undefined
            ? "There isn't another recent task in that direction."
            : `Focused ${focusedTask.title}.`;
    return {
      status: "acknowledged" as const,
      action: "focused" as const,
      projectId: input.projectId,
      message,
    };
  }
  const {
    contextThreadId: _contextThreadId,
    referenceThreadId: _referenceThreadId,
    continueContext: _continueContext,
    ...independentInput
  } = input;
  const startIndependent = desk.newConversationArmed
    ? yield* taskDesk.consumeNewConversation(sessionId)
    : false;

  const result = yield* manager.execute({
    ...(startIndependent ? independentInput : input),
    ...(startIndependent
      ? {}
      : desk.attentionThreadId !== null
        ? { referenceThreadId: desk.attentionThreadId }
        : desk.focusedThreadId !== null
          ? { referenceThreadId: desk.focusedThreadId }
          : input.referenceThreadId === undefined
            ? {}
            : { referenceThreadId: input.referenceThreadId }),
  });
  if (result.status === "started") {
    const existingTask = desk.recentTasks.find((task) => task.threadId === result.threadId);
    const generatedTitle =
      result.objective.length <= 80 ? result.objective : `${result.objective.slice(0, 79)}…`;
    yield* taskDesk.focus({
      sessionId,
      task: {
        threadId: result.threadId,
        projectId: input.projectId,
        title: existingTask?.title ?? generatedTitle,
        objective: existingTask?.objective ?? result.objective,
        state: "running",
        voiceAliases: existingTask?.voiceAliases ?? [],
      },
    });
  }
  return result;
});
