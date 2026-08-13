import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

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
  if (desk.pendingFrame !== null) {
    const currentTime = yield* DateTime.now;
    const selection = input.utterance.trim().toLowerCase();
    const ordinal = new Map([
      ["first", 0],
      ["first one", 0],
      ["1", 0],
      ["one", 0],
      ["second", 1],
      ["second one", 1],
      ["2", 1],
      ["two", 1],
      ["third", 2],
      ["third one", 2],
      ["3", 2],
      ["three", 2],
      ["fourth", 3],
      ["fourth one", 3],
      ["4", 3],
      ["four", 3],
      ["fifth", 4],
      ["fifth one", 4],
      ["5", 4],
      ["five", 4],
    ]).get(selection.replace(/^the\s+/u, ""));
    const expired =
      DateTime.toEpochMillis(desk.pendingFrame.expiresAt) <= DateTime.toEpochMillis(currentTime);
    if (expired || /^(?:cancel|never mind|none)$/u.test(selection)) {
      yield* taskDesk.resolveClarification({ sessionId, threadId: null });
      if (expired) {
        return {
          status: "needs-input" as const,
          reason: "control-target-required" as const,
          prompt: "That task selection expired. Please name the task again.",
          choices: desk.recentTasks.slice(0, 5).map((task) => task.title),
        };
      } else {
        return {
          status: "acknowledged" as const,
          action: "focused" as const,
          projectId: input.projectId,
          message: "Cancelled task selection.",
        };
      }
    } else if (ordinal !== undefined && desk.pendingFrame.candidates[ordinal] !== undefined) {
      const candidate = desk.pendingFrame.candidates[ordinal]!;
      const available = desk.recentTasks.some((task) => task.threadId === candidate.threadId);
      if (!available) {
        yield* taskDesk.resolveClarification({ sessionId, threadId: null });
        return {
          status: "needs-input" as const,
          reason: "control-target-required" as const,
          prompt: "That task is no longer in recent history. Please name the task again.",
          choices: desk.recentTasks.slice(0, 5).map((task) => task.title),
        };
      }
      yield* taskDesk.resolveClarification({ sessionId, threadId: candidate.threadId });
      return {
        status: "acknowledged" as const,
        action: "focused" as const,
        projectId: input.projectId,
        message: `Focused ${candidate.label}.`,
      };
    } else {
      return {
        status: "needs-input" as const,
        reason: "control-target-required" as const,
        prompt: "Which recent task did you mean? Say its number, or say cancel.",
        choices: desk.pendingFrame.candidates.map((candidate) => candidate.label),
      };
    }
  }
  const navigation = resolveTaskDeskNavigation({
    utterance: input.utterance,
    tasks: desk.recentTasks,
  });
  if (navigation.status === "needs-input") {
    if (navigation.candidates.length > 0) {
      const now = yield* DateTime.now;
      yield* taskDesk.setClarification({
        sessionId,
        frame: {
          originalUtterance: input.utterance,
          candidates: navigation.candidates,
          createdAt: now,
          expiresAt: DateTime.add(now, { minutes: 5 }),
        },
      });
    }
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
