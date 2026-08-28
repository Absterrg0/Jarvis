import type {
  DesktopJarvisVoiceState,
  EnvironmentId,
  JarvisNodeCapabilities,
  JarvisExecutionResult,
  JarvisNeedsInput,
  JarvisProjectRef,
  JarvisRequestMetadata,
  JarvisTaskRef,
  JarvisTaskDeskTask,
  ThreadId,
} from "@t3tools/contracts";

export type JarvisVoiceDefaultTarget =
  | {
      readonly kind: "task";
      readonly nodeId: EnvironmentId;
      readonly task: JarvisTaskDeskTask;
    }
  | {
      readonly kind: "project";
      readonly projectRef: JarvisProjectRef;
    };

export interface JarvisVoiceMentionTarget {
  readonly projectRef: JarvisProjectRef;
  readonly projectTitle?: string;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly referenceThreadId?: ThreadId;
  readonly taskRef?: JarvisTaskRef;
}

/** A project named inside a follow-up must not erase its active task identity. */
export function resolveJarvisVoiceMentionTarget(input: {
  readonly projectRef: JarvisProjectRef;
  readonly projectTitle: string;
  readonly currentTarget: JarvisVoiceMentionTarget | null;
}): JarvisVoiceMentionTarget {
  const current = input.currentTarget;
  if (
    current !== null &&
    current.projectRef.nodeId === input.projectRef.nodeId &&
    current.projectRef.projectId === input.projectRef.projectId
  ) {
    return current.projectTitle === undefined
      ? { ...current, projectTitle: input.projectTitle }
      : current;
  }
  return { projectRef: input.projectRef, projectTitle: input.projectTitle };
}

export function isJarvisLocalVoiceRoute(
  originNodeId: EnvironmentId | null,
  routeNodeId: EnvironmentId | undefined,
): boolean {
  return originNodeId !== null && routeNodeId === originNodeId;
}

/**
 * Give a background voice instruction one honest local default. The current
 * Full node's focused task wins; a lone local project is the fallback. Remote
 * nodes remain opt-in through an explicit project phrase.
 */
export function resolveJarvisVoiceDefaultTarget(input: {
  readonly originNodeId: EnvironmentId | null;
  readonly nodes: ReadonlyArray<{
    readonly nodeId: EnvironmentId;
    readonly reachability: "online" | "offline";
    readonly capabilities?: JarvisNodeCapabilities;
  }>;
  readonly projects: ReadonlyArray<{ readonly ref: JarvisProjectRef }>;
  readonly taskDesks: ReadonlyArray<{
    readonly nodeId: EnvironmentId;
    readonly focusedThreadId: JarvisTaskDeskTask["threadId"] | null;
    readonly tasks: ReadonlyArray<JarvisTaskDeskTask>;
  }>;
}): JarvisVoiceDefaultTarget | null {
  if (input.originNodeId === null) return null;
  const originNode = input.nodes.find((node) => node.nodeId === input.originNodeId);
  if (originNode?.reachability !== "online" || originNode.capabilities?.execution !== true) {
    return null;
  }

  const desk = input.taskDesks.find((candidate) => candidate.nodeId === input.originNodeId);
  const focusedTask =
    desk?.focusedThreadId === null || desk?.focusedThreadId === undefined
      ? undefined
      : desk.tasks.find((task) => task.threadId === desk.focusedThreadId);
  if (
    focusedTask !== undefined &&
    (focusedTask.taskRef?.executionNodeId ?? input.originNodeId) === input.originNodeId
  ) {
    return { kind: "task", nodeId: input.originNodeId, task: focusedTask };
  }

  const localProjects = input.projects.filter(
    (project) => project.ref.nodeId === input.originNodeId,
  );
  return localProjects.length === 1 ? { kind: "project", projectRef: localProjects[0]!.ref } : null;
}

export function desktopVoiceCanCapture(state: DesktopJarvisVoiceState | null): boolean {
  return (
    state?.native === true &&
    (state.status === "starting" ||
      state.status === "ready" ||
      state.status === "capturing" ||
      state.status === "speaking")
  );
}

/** A worker in a retryable error can be restarted by the next capture. */
export function desktopVoiceCanStartCapture(state: DesktopJarvisVoiceState | null): boolean {
  return desktopVoiceCanCapture(state) || desktopVoiceCanRetry(state);
}

export function shouldSubmitJarvisVoiceTranscript(
  purpose: "command" | "diagnostic" | undefined,
): boolean {
  return purpose !== "diagnostic";
}

export function isJarvisVoiceGarbageTranscript(transcript: string): boolean {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return true;
  return /^(?:um+|uh+|er+|ah+|hmm+|mm+)$/iu.test(trimmed);
}

export interface JarvisVoiceSubmission {
  readonly captureId: string;
  readonly transcript: string;
  /** Raw ASR text before entity grounding. */
  readonly sourceTranscript?: string;
  /** Allocated once at capture finalization so a manual retry is idempotent. */
  readonly requestId?: string;
}

export function resolveJarvisVoiceProjectChoice(input: {
  readonly instruction: string;
  readonly answer: string;
  readonly candidates: ReadonlyArray<{
    readonly ref: JarvisProjectRef;
    readonly title: string;
    readonly label?: string;
  }>;
}): { readonly instruction: string; readonly projectRef: JarvisProjectRef } | null {
  const answer = input.answer
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (answer.length === 0) return null;
  const ordinalWords = new Map([
    ["first", 1],
    ["second", 2],
    ["third", 3],
    ["fourth", 4],
    ["fifth", 5],
  ]);
  const ordinal = /^(?:the\s+)?(\d+)(?:st|nd|rd|th)?(?:\s+one)?$/u.exec(answer);
  const wordOrdinal = /^(?:the\s+)?(first|second|third|fourth|fifth)(?:\s+one)?$/u.exec(answer);
  const position =
    ordinal?.[1] === undefined
      ? wordOrdinal?.[1] === undefined
        ? undefined
        : ordinalWords.get(wordOrdinal[1])
      : Number(ordinal[1]);
  const positionalCandidate =
    position === undefined || position < 1 ? undefined : input.candidates[position - 1];
  if (positionalCandidate !== undefined) {
    return { instruction: input.instruction, projectRef: positionalCandidate.ref };
  }
  const matches = input.candidates.filter((candidate) =>
    [candidate.title, candidate.label]
      .filter((value): value is string => value !== undefined)
      .some(
        (value) =>
          value
            .trim()
            .toLocaleLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim() === answer,
      ),
  );
  return matches.length === 1
    ? { instruction: input.instruction, projectRef: matches[0]!.ref }
    : null;
}

export interface JarvisVoiceSubmissionQueue {
  readonly enqueue: (
    submission: JarvisVoiceSubmission,
  ) => "enqueued" | "duplicate" | "full" | "empty";
  readonly drain: () => Promise<void>;
  readonly failed: () => JarvisVoiceSubmission | null;
  readonly retryFailed: () => Promise<void>;
  readonly size: () => number;
  readonly clear: () => void;
}

/**
 * Keeps finalized captures independent while one instruction is on the wire.
 * The queue deliberately owns no React state: callers can keep their typed
 * draft and decide when the current catalog is ready to drain it.
 */
export function createJarvisVoiceSubmissionQueue(input: {
  readonly submit: (submission: JarvisVoiceSubmission) => Promise<void>;
  readonly canSubmit?: () => boolean;
  readonly maxPending?: number;
}): JarvisVoiceSubmissionQueue {
  const pending: JarvisVoiceSubmission[] = [];
  const seenCaptureIds = new Set<string>();
  const seenCaptureOrder: string[] = [];
  const maxPending = Math.max(1, input.maxPending ?? 8);
  let activeDrain: Promise<void> | null = null;
  const failedSubmissions: JarvisVoiceSubmission[] = [];

  const drain = (): Promise<void> => {
    if (activeDrain !== null || input.canSubmit?.() === false) {
      return activeDrain ?? Promise.resolve();
    }
    activeDrain = (async () => {
      while (pending.length > 0 && input.canSubmit?.() !== false) {
        const submission = pending.shift()!;
        try {
          await input.submit(submission);
        } catch {
          // A failed item must not strand later captures in the FIFO.
          failedSubmissions.push(submission);
        }
      }
    })().finally(() => {
      activeDrain = null;
      if (pending.length > 0 && input.canSubmit?.() !== false) void drain();
    });
    return activeDrain;
  };

  return {
    enqueue: (submission) => {
      if (submission.transcript.trim().length === 0) return "empty";
      if (submission.captureId.length > 0 && seenCaptureIds.has(submission.captureId)) {
        return "duplicate";
      }
      const inFlight = activeDrain === null ? 0 : 1;
      if (pending.length + failedSubmissions.length + inFlight >= maxPending) return "full";
      if (submission.captureId.length > 0) {
        seenCaptureIds.add(submission.captureId);
        seenCaptureOrder.push(submission.captureId);
        while (seenCaptureOrder.length > 128) {
          const expiredCaptureId = seenCaptureOrder.shift();
          if (expiredCaptureId !== undefined) seenCaptureIds.delete(expiredCaptureId);
        }
      }
      pending.push({ ...submission, transcript: submission.transcript.trim() });
      void drain();
      return "enqueued";
    },
    drain,
    failed: () => failedSubmissions[0] ?? null,
    retryFailed: () => {
      const retry = failedSubmissions.shift();
      if (retry === undefined) return Promise.resolve();
      pending.unshift(retry);
      return drain();
    },
    size: () => pending.length + failedSubmissions.length + (activeDrain === null ? 0 : 1),
    clear: () => {
      pending.length = 0;
      seenCaptureIds.clear();
      seenCaptureOrder.length = 0;
      failedSubmissions.length = 0;
    },
  };
}

export type JarvisDesktopMenuAction =
  | "open-control-center"
  | "voice-toggle"
  | "voice-start"
  | "voice-release";

export function resolveJarvisDesktopMenuAction(action: string): JarvisDesktopMenuAction | null {
  switch (action) {
    case "jarvis.toggle":
      return "open-control-center";
    case "jarvis.voice-toggle":
      return "voice-toggle";
    case "jarvis.voice-start":
      return "voice-start";
    case "jarvis.voice-release":
      return "voice-release";
    default:
      return null;
  }
}

export function desktopVoiceCanRetry(state: DesktopJarvisVoiceState | null): boolean {
  return state?.native === true && state.status === "error";
}

export function desktopVoiceAllowsBrowserFallback(state: DesktopJarvisVoiceState): boolean {
  return !state.native;
}

export function desktopVoiceStatusMessage(state: DesktopJarvisVoiceState | null): string | null {
  if (state === null || !state.native) return null;
  if (state.status === "unavailable") {
    return "Local voice is unavailable. Reinstall Jarvis to restore its bundled voice resources.";
  }
  if (state.status === "error") {
    return "Voice was interrupted. Hold the shortcut to try again, or use Retry.";
  }
  return null;
}

export interface JarvisShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat?: boolean;
}

export function jarvisManagerCatalogIsReady(input: {
  readonly catalogLoaded: boolean;
  readonly catalogPending: boolean;
  readonly catalogError: string | null;
}): boolean {
  return input.catalogLoaded && !input.catalogPending && input.catalogError === null;
}

export type JarvisManagerHeaderState = {
  readonly kind: "loading" | "unavailable" | "target-required" | "execution-unavailable" | "ready";
  readonly label: string;
};

export function jarvisManagerNodeCapabilities(input: {
  readonly capabilities?: JarvisNodeCapabilities;
  readonly catalogError?: string;
}): JarvisNodeCapabilities | null {
  if (input.catalogError !== undefined) return null;
  return input.capabilities ?? null;
}

export function jarvisManagerHeaderState(input: {
  readonly catalogReady: boolean;
  readonly catalogPending: boolean;
  readonly catalogError: string | null;
  readonly hasTarget: boolean;
  readonly targetExecutionAvailable: boolean;
}): JarvisManagerHeaderState {
  if (input.catalogPending || (!input.catalogReady && input.catalogError === null)) {
    return { kind: "loading", label: "Loading capabilities" };
  }
  if (!input.catalogReady || input.catalogError !== null) {
    return { kind: "unavailable", label: "Capabilities unavailable" };
  }
  if (!input.hasTarget) return { kind: "target-required", label: "Choose a project" };
  if (!input.targetExecutionAvailable) {
    return { kind: "execution-unavailable", label: "Execution unavailable" };
  }
  return { kind: "ready", label: "Ready to run" };
}

export function jarvisManagerCanSubmit(input: {
  readonly catalogReady: boolean;
  readonly instruction: string;
  readonly submitting: boolean;
}): boolean {
  return input.catalogReady && input.instruction.trim().length > 0 && !input.submitting;
}

export function isJarvisShortcut(event: JarvisShortcutEvent): boolean {
  return (
    event.key.toLowerCase() === "j" &&
    event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.repeat !== true
  );
}

/** Desktop owns the global voice chord; the renderer shortcut is web-only navigation. */
export function shouldHandleJarvisShortcutInRenderer(desktop: boolean): boolean {
  return !desktop;
}

export function appendJarvisChoice(utterance: string, choice: string): string {
  const instruction = utterance.trim();
  const selection = choice.trim();
  if (instruction.length === 0) return selection;
  if (selection.length === 0) return instruction;
  return `${instruction}\n${selection}`;
}

export interface JarvisRequestFingerprintInput {
  readonly utterance: string;
  readonly projectRef: JarvisProjectRef;
  readonly contextThreadId?: string;
  readonly referenceThreadId?: string;
}

export function jarvisRequestFingerprint(input: JarvisRequestFingerprintInput): string {
  return JSON.stringify({
    utterance: input.utterance.trim(),
    projectRef: input.projectRef,
    ...(input.contextThreadId === undefined ? {} : { contextThreadId: input.contextThreadId }),
    ...(input.referenceThreadId === undefined
      ? {}
      : { referenceThreadId: input.referenceThreadId }),
  });
}

export function resolveJarvisRequestId(input: {
  readonly currentRequestId: string | null;
  readonly currentFingerprint: string | null;
  readonly nextFingerprint: string;
  readonly createRequestId: () => string;
}): string {
  return input.currentRequestId !== null && input.currentFingerprint === input.nextFingerprint
    ? input.currentRequestId
    : input.createRequestId();
}

export function buildJarvisRequestMetadata(input: {
  readonly requestId: string;
  readonly originInteractionId: string;
  readonly originNodeId: EnvironmentId | null;
  readonly inputMode?: "voice";
  readonly sourceUtterance?: string;
}): JarvisRequestMetadata {
  return {
    requestId: input.requestId,
    ...(input.inputMode === undefined ? {} : { inputMode: input.inputMode }),
    ...(input.sourceUtterance === undefined
      ? {}
      : { sourceUtterance: input.sourceUtterance.trim() }),
    origin: {
      ...(input.originNodeId === null ? {} : { originNodeId: input.originNodeId }),
      originInteractionId: input.originInteractionId,
    },
  };
}

const ACTIVE_TASK_STATES = new Set<JarvisTaskDeskTask["state"]>([
  "running",
  "waiting-for-input",
  "waiting-for-approval",
]);

/** Keep recent history available while giving active work the first scan position. */
export function jarvisManagementTasks(
  tasks: ReadonlyArray<JarvisTaskDeskTask>,
): ReadonlyArray<JarvisTaskDeskTask> {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const leftActive = ACTIVE_TASK_STATES.has(left.task.state);
      const rightActive = ACTIVE_TASK_STATES.has(right.task.state);
      return leftActive === rightActive ? left.index - right.index : leftActive ? -1 : 1;
    })
    .map(({ task }) => task);
}

export function jarvisTaskStateLabel(state: JarvisTaskDeskTask["state"]): string {
  return state === "ready" ? "completed" : state.replaceAll("-", " ");
}

export function jarvisSelectedTargetPresentation(input: {
  readonly targetTitle?: string;
  readonly projectTitle?: string;
  readonly nodeLabel?: string;
  readonly providerLabel?: string;
  readonly taskState?: JarvisTaskDeskTask["state"];
}): { readonly title: string; readonly detail: string } {
  const title = input.targetTitle ?? input.projectTitle ?? "Choose a project";
  const detail = [
    input.projectTitle,
    input.nodeLabel,
    input.providerLabel,
    input.taskState === undefined ? undefined : jarvisTaskStateLabel(input.taskState),
  ]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join(" · ");
  return { title, detail: detail || "Choose a project" };
}

/** Resolve the node/thread pair used by the deep T3 session affordance. */
export function jarvisFullSessionTarget(
  nodeId: EnvironmentId,
  task: JarvisTaskDeskTask,
): { readonly environmentId: EnvironmentId; readonly threadId: JarvisTaskDeskTask["threadId"] } {
  return {
    environmentId: task.taskRef?.executionNodeId ?? nodeId,
    threadId: task.taskRef?.remoteThreadId ?? task.threadId,
  };
}

export function jarvisTaskExecutionTarget(
  nodeId: EnvironmentId,
  task: JarvisTaskDeskTask,
): { readonly environmentId: EnvironmentId; readonly projectId: JarvisTaskDeskTask["projectId"] } {
  return {
    environmentId: task.taskRef?.executionNodeId ?? nodeId,
    projectId: task.taskRef?.projectId ?? task.projectId,
  };
}

export function applyJarvisClarificationChoice(
  utterance: string,
  clarification: JarvisNeedsInput,
  choice: string,
): string {
  const selection = choice.trim();
  if (selection.length === 0) return utterance.trim();
  switch (clarification.reason) {
    case "control-target-required":
      // The task desk owns the original request while project confirmation is
      // pending. Send only this answer so its yes/no/ordinal parser can consume
      // the frame and resume that request exactly once.
      return selection;
    case "provider-not-found":
      return utterance.replace(/\b(use|with|through)\s+\S+/iu, `$1 ${selection}`);
    case "model-unavailable": {
      const providerWithoutModel = /(\b(?:use|with|through)\s+\S+)(\s+to\b)/iu;
      if (providerWithoutModel.test(utterance)) {
        return utterance.replace(providerWithoutModel, `$1 ${selection}$2`);
      }
      return utterance.replace(/(\b(?:use|with|through)\s+\S+\s+)\S+/iu, `$1${selection}`);
    }
    case "effort-missing":
      return utterance.replace(/\b(agent\s+)?to\b/iu, `${selection} $&`);
    case "effort-unavailable":
      return utterance.replace(
        /\b(minimal|low|medium|high|xhigh|max|ultra|ultrathink)\b/iu,
        selection,
      );
    default:
      return appendJarvisChoice(utterance, selection);
  }
}

export function jarvisErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return "Jarvis couldn’t start that task. Check the connection and try again.";
}

export function jarvisTaskStartedText(input: {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}): string {
  const effort = input.options?.find((option) => /effort|reason|thought/iu.test(option.id));
  const effortSuffix = typeof effort?.value === "string" ? ` at ${effort.value} effort` : "";
  return `Starting ${input.instanceId} ${input.model}${effortSuffix}.`;
}

export function jarvisExecutionSpeechText(result: JarvisExecutionResult): string {
  if (result.status === "started") return "";
  if (result.status === "needs-input") return result.prompt;
  return result.message;
}
