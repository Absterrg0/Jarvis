import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import type { JarvisManagerExecuteInput, JarvisManagerShape } from "./Services/JarvisManager.ts";
import type { JarvisTaskDeskShape } from "./Services/JarvisTaskDesk.ts";
import { jarvisRequestAcceptanceKey } from "@t3tools/jarvis-core/requestIdentity";
import { resolveTaskDeskNavigation } from "@t3tools/jarvis-core/resolveTaskDeskNavigation";

const normalizeSpokenSelection = (utterance: string): string =>
  utterance
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/u, "");

export const executeWithTaskDesk = Effect.fn("Jarvis.executeWithTaskDesk")(function* (
  manager: JarvisManagerShape,
  taskDesk: JarvisTaskDeskShape,
  sessionId: AuthSessionId,
  input: JarvisManagerExecuteInput,
) {
  const desk = yield* taskDesk.get(sessionId);
  let executionInput = input;
  let resumesProjectClarification = false;
  if (desk.pendingProjectFrame !== null) {
    const selection = normalizeSpokenSelection(executionInput.utterance);
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
    const now = yield* DateTime.now;
    if (DateTime.toEpochMillis(desk.pendingProjectFrame.expiresAt) <= DateTime.toEpochMillis(now)) {
      yield* taskDesk.clearProjectClarification(sessionId);
      return {
        status: "needs-input" as const,
        reason: "control-target-required" as const,
        prompt: "That project confirmation expired. Please name the project again.",
        choices: [],
      };
    }
    if (/^(?:no|cancel|never mind|none)$/u.test(selection)) {
      yield* taskDesk.clearProjectClarification(sessionId);
      return {
        status: "acknowledged" as const,
        action: "focused" as const,
        projectId: executionInput.projectId,
        message: "Cancelled project selection.",
      };
    }
    const affirmative = /^(?:yes|yeah|yep|confirm|correct|that one)$/u.test(selection);
    const selectedIndex =
      affirmative && desk.pendingProjectFrame.candidates.length === 1
        ? 0
        : ordinal === undefined
          ? undefined
          : ordinal;
    if (
      selectedIndex !== undefined &&
      desk.pendingProjectFrame.candidates[selectedIndex] !== undefined
    ) {
      const frame = yield* taskDesk.consumeProjectClarification(sessionId);
      if (frame === null) {
        return {
          status: "needs-input" as const,
          reason: "control-target-required" as const,
          prompt: "That project selection was already handled. Please restate your request.",
          choices: [],
        };
      }
      const candidate = frame.candidates[selectedIndex];
      if (candidate === undefined) {
        return {
          status: "needs-input" as const,
          reason: "control-target-required" as const,
          prompt: "That project choice is no longer available. Please name the project again.",
          choices: [],
        };
      }
      const resumedRequestMetadata = frame.requestMetadata ?? executionInput.requestMetadata;
      executionInput = {
        projectId: frame.originProjectId,
        utterance: frame.originalUtterance,
        confirmedProjectId: candidate.projectId,
        ...(candidate.learnedAlias === undefined
          ? {}
          : { confirmedProjectAlias: candidate.learnedAlias }),
        ...(frame.contextThreadId === undefined ? {} : { contextThreadId: frame.contextThreadId }),
        ...(frame.referenceThreadId === undefined
          ? {}
          : { referenceThreadId: frame.referenceThreadId }),
        ...(frame.continueContext === undefined ? {} : { continueContext: frame.continueContext }),
        ...(frame.modelSelection === undefined ? {} : { modelSelection: frame.modelSelection }),
        ...(resumedRequestMetadata === undefined
          ? {}
          : { requestMetadata: resumedRequestMetadata }),
        ...(executionInput.executionNodeId === undefined
          ? {}
          : { executionNodeId: executionInput.executionNodeId }),
      };
      resumesProjectClarification = true;
    } else {
      return {
        status: "needs-input" as const,
        reason: "control-target-required" as const,
        prompt:
          desk.pendingProjectFrame.candidates.length === 1
            ? `Did you mean ${desk.pendingProjectFrame.candidates[0]!.label}? Say yes or no.`
            : "Which project did you mean? Say its number, or say cancel.",
        choices: desk.pendingProjectFrame.candidates.map(({ label }) => label),
      };
    }
  }
  if (desk.pendingFrame !== null) {
    const currentTime = yield* DateTime.now;
    const selection = normalizeSpokenSelection(executionInput.utterance);
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
          projectId: executionInput.projectId,
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
        projectId: executionInput.projectId,
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
    utterance: executionInput.utterance,
    tasks: desk.recentTasks,
  });
  if (navigation.status === "needs-input") {
    if (navigation.candidates.length > 0) {
      const now = yield* DateTime.now;
      yield* taskDesk.setClarification({
        sessionId,
        frame: {
          originalUtterance: executionInput.utterance,
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
      projectId: executionInput.projectId,
      message,
    };
  }
  const {
    contextThreadId: _contextThreadId,
    referenceThreadId: _referenceThreadId,
    continueContext: _continueContext,
    ...independentInput
  } = executionInput;
  const startIndependent =
    !resumesProjectClarification && desk.newConversationArmed
      ? yield* taskDesk.consumeNewConversation(sessionId)
      : false;

  const result = yield* manager.execute({
    ...(startIndependent ? independentInput : executionInput),
    ...(executionInput.executionNodeId === undefined
      ? {}
      : { executionNodeId: executionInput.executionNodeId }),
    ...(executionInput.requestMetadata === undefined
      ? {}
      : {
          requestMetadata: executionInput.requestMetadata,
          acceptanceKey: jarvisRequestAcceptanceKey({
            executionNodeId: executionInput.executionNodeId,
            requestMetadata: executionInput.requestMetadata,
          }),
        }),
    ...(startIndependent
      ? {}
      : resumesProjectClarification
        ? executionInput.referenceThreadId === undefined
          ? {}
          : { referenceThreadId: executionInput.referenceThreadId }
        : desk.attentionThreadId !== null
          ? { referenceThreadId: desk.attentionThreadId }
          : desk.focusedThreadId !== null
            ? { referenceThreadId: desk.focusedThreadId }
            : executionInput.referenceThreadId === undefined
              ? {}
              : { referenceThreadId: executionInput.referenceThreadId }),
  });
  if (result.status === "needs-input" && result.projectClarification !== undefined) {
    const now = yield* DateTime.now;
    yield* taskDesk.setProjectClarification({
      sessionId,
      frame: {
        originalUtterance: executionInput.utterance,
        originProjectId: executionInput.projectId,
        ...(executionInput.contextThreadId === undefined
          ? {}
          : { contextThreadId: executionInput.contextThreadId }),
        ...(executionInput.referenceThreadId === undefined
          ? {}
          : { referenceThreadId: executionInput.referenceThreadId }),
        ...(executionInput.continueContext === undefined
          ? {}
          : { continueContext: executionInput.continueContext }),
        ...(executionInput.modelSelection === undefined
          ? {}
          : { modelSelection: executionInput.modelSelection }),
        ...(executionInput.requestMetadata === undefined
          ? {}
          : { requestMetadata: executionInput.requestMetadata }),
        candidates: result.projectClarification.candidates,
        createdAt: now,
        expiresAt: DateTime.add(now, { minutes: 5 }),
      },
    });
    const { projectClarification: _projectClarification, ...publicResult } = result;
    return publicResult;
  }
  if (result.status === "started") {
    const existingTask = desk.recentTasks.find((task) => task.threadId === result.threadId);
    const generatedTitle =
      result.objective.length <= 80 ? result.objective : `${result.objective.slice(0, 79)}…`;
    yield* taskDesk.focus({
      sessionId,
      task: {
        threadId: result.threadId,
        projectId: executionInput.confirmedProjectId ?? executionInput.projectId,
        ...(result.taskRef === undefined ? {} : { taskRef: result.taskRef }),
        title: existingTask?.title ?? generatedTitle,
        objective: existingTask?.objective ?? result.objective,
        state: "running",
        voiceAliases: existingTask?.voiceAliases ?? [],
      },
    });
  }
  return result;
});
