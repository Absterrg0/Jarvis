import type { AuthSessionId, JarvisTaskDeskTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { jarvisRequestAcceptanceKey } from "@t3tools/jarvis-core/requestIdentity";
import {
  resolveTaskDeskNavigation,
  type JarvisTaskDeskCandidate,
} from "@t3tools/jarvis-core/resolveTaskDeskNavigation";
import type { JarvisManagerExecuteInput, JarvisManagerShape } from "./Services/JarvisManager.ts";
import type { JarvisTaskDeskShape } from "./Services/JarvisTaskDesk.ts";

const normalize = (utterance: string): string =>
  utterance
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/u, "");

const ordinal = (answer: string): number | undefined => {
  const normalized = normalize(answer).replace(/^the\s+/u, "");
  return new Map([
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
  ]).get(normalized);
};

const taskCandidates = (
  tasks: ReadonlyArray<JarvisTaskDeskTask>,
): ReadonlyArray<JarvisTaskDeskCandidate> =>
  tasks.map((task) => ({
    ...task,
    title: task.threadId,
    objective: task.threadId,
    state: "known",
    voiceAliases: [],
  }));

export const executeWithTaskDesk = Effect.fn("Jarvis.executeWithTaskDesk")(function* (
  manager: JarvisManagerShape,
  taskDesk: JarvisTaskDeskShape,
  sessionId: AuthSessionId,
  input: JarvisManagerExecuteInput,
  liveTasks: ReadonlyArray<JarvisTaskDeskCandidate> = [],
) {
  let desk = yield* taskDesk.get(sessionId);
  let executionInput = input;
  const pending = desk.pendingInteraction;
  if (pending !== null) {
    const answer = normalize(executionInput.utterance);
    const now = yield* DateTime.now;
    if (DateTime.toEpochMillis(pending.frame.expiresAt) <= DateTime.toEpochMillis(now)) {
      yield* taskDesk.clearPendingInteraction(sessionId);
      return {
        status: "needs-input" as const,
        reason: "control-target-required" as const,
        prompt: "That selection expired. Please restate the request.",
        choices: [],
      };
    }
    if (/^(?:cancel|never mind|none|no)$/u.test(answer)) {
      yield* taskDesk.clearPendingInteraction(sessionId);
      return {
        status: "acknowledged" as const,
        action: "focused" as const,
        projectId: executionInput.projectId,
        message: "Cancelled selection.",
      };
    }
    const selected =
      /^(?:yes|yeah|yep|confirm|correct|that one)$/u.test(answer) &&
      pending.frame.candidates.length === 1
        ? 0
        : ordinal(answer);
    if (pending.kind === "task") {
      const candidate = selected === undefined ? undefined : pending.frame.candidates[selected];
      if (candidate === undefined) {
        return {
          status: "needs-input" as const,
          reason: "control-target-required" as const,
          prompt: "Which recent task did you mean? Say its number, or say cancel.",
          choices: pending.frame.candidates.map((item) => item.label),
        };
      }
      const task = desk.recentTasks.find((item) => item.threadId === candidate.threadId);
      if (task === undefined) {
        yield* taskDesk.clearPendingInteraction(sessionId);
        return {
          status: "needs-input" as const,
          reason: "control-target-required" as const,
          prompt: "That task is no longer available. Please name it again.",
          choices: [],
        };
      }
      yield* taskDesk.focus({ sessionId, task });
      return {
        status: "acknowledged" as const,
        action: "focused" as const,
        projectId: executionInput.projectId,
        message: `Focused ${candidate.label}.`,
      };
    }
    const candidate = selected === undefined ? undefined : pending.frame.candidates[selected];
    if (candidate === undefined) {
      return {
        status: "needs-input" as const,
        reason: "control-target-required" as const,
        prompt:
          pending.frame.candidates.length === 1
            ? `Did you mean ${pending.frame.candidates[0]!.label}? Say yes or no.`
            : "Which project did you mean? Say its number, or say cancel.",
        choices: pending.frame.candidates.map((item) => item.label),
      };
    }
    const frame = yield* taskDesk.consumePendingInteraction(sessionId);
    if (frame === null || frame.kind !== "project") {
      return {
        status: "needs-input" as const,
        reason: "control-target-required" as const,
        prompt: "That project selection was already handled. Please restate your request.",
        choices: [],
      };
    }
    executionInput = {
      ...executionInput,
      utterance: frame.frame.originalUtterance,
      confirmedProjectId: candidate.projectId,
      ...(candidate.learnedAlias === undefined
        ? {}
        : { confirmedProjectAlias: candidate.learnedAlias }),
      ...(frame.frame.contextThreadId === undefined
        ? {}
        : { contextThreadId: frame.frame.contextThreadId }),
      ...(frame.frame.referenceThreadId === undefined
        ? {}
        : { referenceThreadId: frame.frame.referenceThreadId }),
      ...(frame.frame.continueContext === undefined
        ? {}
        : { continueContext: frame.frame.continueContext }),
      ...(frame.frame.modelSelection === undefined
        ? {}
        : { modelSelection: frame.frame.modelSelection }),
      ...(frame.frame.requestMetadata === undefined
        ? {}
        : { requestMetadata: frame.frame.requestMetadata }),
    };
    desk = yield* taskDesk.get(sessionId);
  }

  const navigation = resolveTaskDeskNavigation({
    utterance: executionInput.utterance,
    tasks:
      liveTasks.length === 0
        ? taskCandidates(desk.recentTasks)
        : liveTasks.filter((candidate) =>
            desk.recentTasks.some((task) => task.threadId === candidate.threadId),
          ),
  });
  if (navigation.status === "needs-input") {
    if (navigation.candidates.length > 0) {
      const now = yield* DateTime.now;
      yield* taskDesk.setPendingInteraction({
        sessionId,
        interaction: {
          kind: "task",
          frame: {
            originalUtterance: executionInput.utterance,
            candidates: navigation.candidates,
            createdAt: now,
            expiresAt: DateTime.add(now, { minutes: 5 }),
          },
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
    const nextDesk = yield* taskDesk.navigate({ sessionId, navigation: navigation.navigation });
    return {
      status: "acknowledged" as const,
      action: "focused" as const,
      projectId: executionInput.projectId,
      message:
        nextDesk.focusedTask === null
          ? "There is no matching recent task."
          : `Focused ${nextDesk.focusedTask.threadId}.`,
    };
  }

  const result = yield* manager.execute({
    ...executionInput,
    ...(executionInput.requestMetadata === undefined
      ? {}
      : {
          acceptanceKey: jarvisRequestAcceptanceKey({
            executionNodeId: executionInput.executionNodeId,
            requestMetadata: executionInput.requestMetadata,
          }),
        }),
    ...(executionInput.referenceThreadId === undefined && desk.focusedTask !== null
      ? { referenceThreadId: desk.focusedTask.threadId }
      : {}),
  });
  if (result.status === "needs-input" && result.projectClarification !== undefined) {
    const now = yield* DateTime.now;
    yield* taskDesk.setPendingInteraction({
      sessionId,
      interaction: {
        kind: "project",
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
      },
    });
    const { projectClarification: _projectClarification, ...publicResult } = result;
    return publicResult;
  }
  if (result.status === "started") {
    const projectId =
      result.projectId ??
      result.taskRef?.projectId ??
      executionInput.confirmedProjectId ??
      executionInput.projectId;
    yield* taskDesk.focus({
      sessionId,
      task: {
        threadId: result.threadId,
        ...(result.taskRef === undefined ? {} : { taskRef: result.taskRef }),
        ...(projectId === undefined || result.taskRef?.executionNodeId === undefined
          ? {}
          : { projectRef: { nodeId: result.taskRef.executionNodeId, projectId } }),
      },
    });
  }
  return result;
});
