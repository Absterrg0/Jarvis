import {
  type EnvironmentId,
  JarvisTaskCreatedActivityPayload,
  type JarvisRequestMetadata,
  type JarvisTaskDeskTask,
  type JarvisTaskRef,
  type ModelSelection,
  type OrchestrationThread,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type JarvisCommandTask,
  type JarvisTaskNavigationCandidate,
} from "@t3tools/jarvis-core/command";
import { findPendingReply } from "@t3tools/jarvis-core/confirmation";
import { deriveJarvisTaskState } from "@t3tools/jarvis-core/deriveTaskState";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeTaskCreatedPayload = Schema.decodeUnknownOption(JarvisTaskCreatedActivityPayload);

export function taskTitle(objective: string): string {
  const withoutTerminalPunctuation = objective.replace(/[.!?]+$/u, "");
  return withoutTerminalPunctuation.length <= 80
    ? withoutTerminalPunctuation
    : `${withoutTerminalPunctuation.slice(0, 79)}…`;
}

function modelSelectionsMatch(left: ModelSelection, right: ModelSelection): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const leftOptions = left.options ?? [];
  const rightOptions = right.options ?? [];
  if (leftOptions.length !== rightOptions.length) return false;
  return leftOptions.every((option) =>
    rightOptions.some(
      (candidate) => candidate.id === option.id && candidate.value === option.value,
    ),
  );
}

function requestMetadataMatch(
  left: JarvisRequestMetadata | undefined,
  right: JarvisRequestMetadata,
): boolean {
  if (left?.requestId !== right.requestId) return false;
  if (left.inputMode !== right.inputMode) return false;
  if (left.sourceUtterance !== right.sourceUtterance) return false;
  return (
    left.origin?.originNodeId === right.origin?.originNodeId &&
    left.origin?.originInteractionId === right.origin?.originInteractionId
  );
}

function taskCreatedPayload(thread: OrchestrationThread) {
  const marker = thread.activities.findLast((activity) => activity.kind === "jarvis.task.created");
  return marker === undefined
    ? undefined
    : Option.getOrUndefined(decodeTaskCreatedPayload(marker.payload));
}

export function routedThreadMatches(input: {
  readonly thread: OrchestrationThread;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly objective: string;
  readonly modelSelection: ModelSelection;
  readonly requestMetadata: JarvisRequestMetadata;
}): boolean {
  if (
    input.thread.projectId !== input.projectId ||
    !modelSelectionsMatch(input.thread.modelSelection, input.modelSelection)
  ) {
    return false;
  }
  const marker = input.thread.activities.findLast(
    (activity) => activity.kind === "jarvis.task.created",
  );
  if (marker === undefined) return input.thread.title === input.title;
  const payload = Option.getOrUndefined(decodeTaskCreatedPayload(marker.payload));
  return (
    payload !== undefined &&
    payload.objective === input.objective &&
    requestMetadataMatch(payload.requestMetadata, input.requestMetadata)
  );
}

export function taskRefFor(
  executionNodeId: EnvironmentId | undefined,
  threadId: ThreadId,
): JarvisTaskRef | undefined {
  return executionNodeId === undefined ? undefined : { executionNodeId, threadId };
}

export const normalizeTaskDeskAnswer = (utterance: string): string =>
  utterance
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/u, "");

export const ordinalTaskChoice = (answer: string): number | undefined => {
  const normalized = normalizeTaskDeskAnswer(answer).replace(/^the\s+/u, "");
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

export function commandTaskFromThread(input: {
  readonly thread: OrchestrationThread;
  readonly projectTitle: string;
  readonly executionNodeId?: EnvironmentId;
  readonly queuedFollowUps?: number;
}): JarvisCommandTask {
  const marker = taskCreatedPayload(input.thread);
  const pending = findPendingReply(input.thread.activities);
  const taskRef = marker?.taskRef ?? taskRefFor(input.executionNodeId, input.thread.id);
  return {
    threadId: input.thread.id,
    projectId: input.thread.projectId,
    projectTitle: input.projectTitle,
    title: input.thread.title,
    objective:
      marker?.objective ??
      input.thread.messages.find((message) => message.role === "user")?.text.trim() ??
      input.thread.title,
    state: deriveJarvisTaskState({
      latestTurn: input.thread.latestTurn,
      session: input.thread.session,
      hasPendingApprovals: pending?.kind === "approval",
      hasPendingUserInput: pending?.kind === "user-input",
    }),
    ...(input.queuedFollowUps === undefined || input.queuedFollowUps === 0
      ? {}
      : { queuedFollowUps: input.queuedFollowUps }),
    ...(taskRef === undefined ? {} : { taskRef }),
    ...(taskRef === undefined
      ? {}
      : { projectRef: { nodeId: taskRef.executionNodeId, projectId: input.thread.projectId } }),
  };
}

function navigationCandidateFromShell(input: {
  readonly thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly latestTurn: OrchestrationThread["latestTurn"];
    readonly session: OrchestrationThread["session"];
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
  };
  readonly executionNodeId?: EnvironmentId;
  readonly taskRef?: JarvisTaskRef;
}): JarvisTaskNavigationCandidate {
  const taskRef = input.taskRef ?? taskRefFor(input.executionNodeId, input.thread.id);
  return {
    threadId: input.thread.id,
    title: input.thread.title,
    objective: input.thread.title,
    state: deriveJarvisTaskState(input.thread),
    projectId: input.thread.projectId,
    ...(taskRef === undefined ? {} : { taskRef }),
  };
}

export function navigationCandidateFromDesk(
  task: JarvisTaskDeskTask,
  liveThread?: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly latestTurn: OrchestrationThread["latestTurn"];
    readonly session: OrchestrationThread["session"];
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
  },
): JarvisTaskNavigationCandidate | null {
  if (liveThread === undefined) return null;
  return navigationCandidateFromShell({
    thread: liveThread,
    taskRef: task.taskRef,
    executionNodeId: task.taskRef.executionNodeId,
  });
}
