import type {
  DesktopJarvisVoiceState,
  EnvironmentId,
  JarvisNodeCapabilities,
  JarvisExecutionResult,
  JarvisNeedsInput,
  JarvisProjectRef,
  JarvisRequestMetadata,
  JarvisTaskRef,
  JarvisTaskDeskTaskView,
  ThreadId,
} from "@t3tools/contracts";

export type JarvisVoiceDefaultTarget =
  | {
      readonly kind: "task";
      readonly nodeId: EnvironmentId;
      readonly task: JarvisTaskDeskTaskView;
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
    readonly focusedThreadId: JarvisTaskDeskTaskView["threadId"] | null;
    readonly tasks: ReadonlyArray<JarvisTaskDeskTaskView>;
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
  if (focusedTask !== undefined && focusedTask.taskRef.executionNodeId === input.originNodeId) {
    return { kind: "task", nodeId: input.originNodeId, task: focusedTask };
  }

  const localProjects = input.projects.filter(
    (project) => project.ref.nodeId === input.originNodeId,
  );
  return localProjects.length === 1 ? { kind: "project", projectRef: localProjects[0]!.ref } : null;
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
  readonly acceptsAffirmation?: boolean;
}): { readonly instruction: string; readonly projectRef: JarvisProjectRef } | null {
  const answer = input.answer
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (answer.length === 0) return null;
  if (
    input.acceptsAffirmation === true &&
    /^(?:yes|yeah|yep|correct|that one|use that)$/u.test(answer) &&
    input.candidates.length === 1 &&
    input.candidates[0] !== undefined
  ) {
    return { instruction: input.instruction, projectRef: input.candidates[0].ref };
  }
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
  readonly resume: (
    captureId: string,
    submission: JarvisVoiceSubmission,
  ) => "resumed" | "missing" | "empty";
  readonly discard: (captureId: string) => boolean;
  readonly failed: () => JarvisVoiceSubmission | null;
  readonly retryFailed: () => Promise<void>;
  readonly size: () => number;
  readonly clear: () => void;
}

export function isJarvisVoiceClarificationDiscard(answer: string): boolean {
  const normalized = answer
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return /^(?:no(?: thanks)?|cancel(?: it| that| this)?|discard(?: it| that| this)?|never ?mind|forget it|stop)$/u.test(
    normalized,
  );
}

/**
 * Keeps finalized captures independent while one instruction is on the wire.
 * The queue deliberately owns no React state: callers can keep their typed
 * draft and decide when the current catalog is ready to drain it.
 */
export function createJarvisVoiceSubmissionQueue(input: {
  readonly submit: (submission: JarvisVoiceSubmission) => Promise<void | "complete" | "pause">;
  readonly canSubmit?: () => boolean;
  readonly maxPending?: number;
}): JarvisVoiceSubmissionQueue {
  const pending: JarvisVoiceSubmission[] = [];
  const seenCaptureIds = new Set<string>();
  const seenCaptureOrder: string[] = [];
  const maxPending = Math.max(1, input.maxPending ?? 8);
  let activeDrain: Promise<void> | null = null;
  let pausedCaptureId: string | null = null;
  let generation = 0;
  const failedSubmissions: JarvisVoiceSubmission[] = [];

  const drain = (): Promise<void> => {
    if (activeDrain !== null || pausedCaptureId !== null || input.canSubmit?.() === false) {
      return activeDrain ?? Promise.resolve();
    }
    const drainGeneration = generation;
    activeDrain = (async () => {
      while (
        generation === drainGeneration &&
        pending.length > 0 &&
        input.canSubmit?.() !== false
      ) {
        const submission = pending[0];
        if (submission === undefined) break;
        try {
          const outcome = await input.submit(submission);
          if (generation !== drainGeneration) break;
          if (outcome === "pause") {
            pausedCaptureId = submission.captureId;
            break;
          }
          if (pending[0] === submission) pending.shift();
        } catch {
          if (generation !== drainGeneration) break;
          // A failed item must not strand later captures in the FIFO.
          if (pending[0] === submission) {
            const failed = pending.shift();
            if (failed !== undefined) failedSubmissions.push(failed);
          }
        }
      }
    })().finally(() => {
      activeDrain = null;
      if (pending.length > 0 && pausedCaptureId === null && input.canSubmit?.() !== false) {
        void drain();
      }
    });
    return activeDrain;
  };

  return {
    enqueue: (submission) => {
      if (submission.transcript.trim().length === 0) return "empty";
      if (submission.captureId.length > 0 && seenCaptureIds.has(submission.captureId)) {
        return "duplicate";
      }
      if (pending.length + failedSubmissions.length >= maxPending) return "full";
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
    resume: (captureId, submission) => {
      if (submission.transcript.trim().length === 0) return "empty";
      if (pausedCaptureId !== captureId) return "missing";
      const index = pending.findIndex((candidate) => candidate.captureId === captureId);
      if (index === -1) return "missing";
      pending[index] = {
        ...submission,
        captureId,
        transcript: submission.transcript.trim(),
      };
      if (pausedCaptureId === captureId) pausedCaptureId = null;
      void drain();
      return "resumed";
    },
    discard: (captureId) => {
      const index = pending.findIndex((candidate) => candidate.captureId === captureId);
      if (index === -1) return false;
      pending.splice(index, 1);
      if (pausedCaptureId === captureId) pausedCaptureId = null;
      void drain();
      return true;
    },
    failed: () => failedSubmissions[0] ?? null,
    retryFailed: () => {
      const retry = failedSubmissions.shift();
      if (retry === undefined) return Promise.resolve();
      pending.unshift(retry);
      return drain();
    },
    size: () => pending.length + failedSubmissions.length,
    clear: () => {
      generation += 1;
      pending.length = 0;
      seenCaptureIds.clear();
      seenCaptureOrder.length = 0;
      failedSubmissions.length = 0;
      pausedCaptureId = null;
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

export function desktopVoiceAllowsBrowserFallback(state: DesktopJarvisVoiceState): boolean {
  return !state.native;
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

export type JarvisExecutionFeedback = {
  readonly cue: boolean;
  readonly speech: string;
  readonly visual: {
    readonly state: string;
    readonly detail: string;
    readonly kind: string;
  };
};

/** Converts an authoritative Director result into user-facing feedback. */
export function jarvisExecutionFeedback(result: JarvisExecutionResult): JarvisExecutionFeedback {
  if (result.status === "needs-input") {
    return {
      cue: false,
      speech: result.prompt,
      visual: { state: "Need one detail", detail: result.prompt, kind: "error" },
    };
  }
  if (result.status === "acknowledged") {
    return {
      cue: false,
      speech: result.message,
      visual: { state: "Jarvis", detail: result.message, kind: "completed" },
    };
  }
  return {
    cue: false,
    speech: result.acknowledgement ?? "Working on it.",
    visual: { state: "Working on it", detail: result.objective, kind: "started" },
  };
}
