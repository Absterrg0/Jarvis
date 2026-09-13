import type {
  EnvironmentId,
  CirceNodeCapabilities,
  CirceExecutionResult,
  CirceNeedsInput,
  CirceProjectRef,
  CirceRequestMetadata,
  CirceSemanticProposal,
  CirceTaskRef,
  CirceTaskDeskTaskView,
  ThreadId,
} from "@t3tools/contracts";
import { isCirceClarificationDiscard } from "@circe/core/clarification";
import { resolveCirceProjectChoice } from "@circe/core/projectChoice";

/**
 * Short-lived memo for repeated conversational turns. Only complete converse
 * proposals with a spoken answer are eligible: they dispatch nothing, so a
 * repeated identical question within the TTL can skip the supervisor round
 * trip. Command proposals are never cached.
 */
export interface CirceConversationAnswerCache {
  get: (key: string, now?: number) => CirceSemanticProposal | null;
  set: (key: string, proposal: CirceSemanticProposal, now?: number) => void;
  clear: () => void;
}

export function createCirceConversationAnswerCache(input?: {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}): CirceConversationAnswerCache {
  const ttlMs = input?.ttlMs ?? 120_000;
  const maxEntries = Math.max(1, input?.maxEntries ?? 16);
  const entries = new Map<
    string,
    { readonly proposal: CirceSemanticProposal; readonly at: number }
  >();
  const prune = (now: number): void => {
    for (const [key, entry] of entries) {
      if (now - entry.at > ttlMs) entries.delete(key);
    }
  };
  return {
    get: (key, now = Date.now()) => {
      prune(now);
      return entries.get(key)?.proposal ?? null;
    },
    set: (key, proposal, now = Date.now()) => {
      if (proposal.action !== "converse" || proposal.answer === null) return;
      prune(now);
      entries.delete(key);
      entries.set(key, { proposal, at: now });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear: () => {
      entries.clear();
    },
  };
}

export type CirceVoiceDefaultTarget =
  | {
      readonly kind: "task";
      readonly nodeId: EnvironmentId;
      readonly task: CirceTaskDeskTaskView;
    }
  | {
      readonly kind: "project";
      readonly projectRef: CirceProjectRef;
    };

export interface CirceVoiceMentionTarget {
  readonly projectRef: CirceProjectRef;
  readonly projectTitle?: string;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly referenceThreadId?: ThreadId;
  readonly taskRef?: CirceTaskRef;
}

/** A project named inside a follow-up must not erase its active task identity. */
export function resolveCirceVoiceMentionTarget(input: {
  readonly projectRef: CirceProjectRef;
  readonly projectTitle: string;
  readonly currentTarget: CirceVoiceMentionTarget | null;
}): CirceVoiceMentionTarget {
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

export function isCirceLocalVoiceRoute(
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
export function resolveCirceVoiceDefaultTarget(input: {
  readonly originNodeId: EnvironmentId | null;
  readonly nodes: ReadonlyArray<{
    readonly nodeId: EnvironmentId;
    readonly reachability: "online" | "offline";
    readonly capabilities?: CirceNodeCapabilities;
  }>;
  readonly projects: ReadonlyArray<{ readonly ref: CirceProjectRef }>;
  readonly taskDesks: ReadonlyArray<{
    readonly nodeId: EnvironmentId;
    readonly focusedThreadId: CirceTaskDeskTaskView["threadId"] | null;
    readonly tasks: ReadonlyArray<CirceTaskDeskTaskView>;
  }>;
}): CirceVoiceDefaultTarget | null {
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

/**
 * The workspace that hosts a project-free conversation. Any real project is a
 * valid home: the provider needs a workspace to run tools in, and the thread
 * needs a project to be durable and visible. Preference order: the focused
 * task, the lone local project, the most recently used task's project, then
 * the first project on the origin node. Null only when the node owns no
 * project at all.
 */
export function resolveCirceConversationProjectRef(input: {
  readonly originNodeId: EnvironmentId | null;
  readonly nodes: ReadonlyArray<{
    readonly nodeId: EnvironmentId;
    readonly reachability: "online" | "offline";
    readonly capabilities?: CirceNodeCapabilities;
  }>;
  readonly projects: ReadonlyArray<{ readonly ref: CirceProjectRef }>;
  readonly taskDesks: ReadonlyArray<{
    readonly nodeId: EnvironmentId;
    readonly focusedThreadId: CirceTaskDeskTaskView["threadId"] | null;
    readonly tasks: ReadonlyArray<CirceTaskDeskTaskView>;
  }>;
}): CirceProjectRef | null {
  const preferred = resolveCirceVoiceDefaultTarget(input);
  if (preferred !== null) {
    return preferred.kind === "project" ? preferred.projectRef : preferred.task.projectRef;
  }
  if (input.originNodeId === null) return null;
  // Unknown capabilities (config still loading) must not force the tool-less
  // inline answer: the execution node validates execution when the turn runs.
  // Only an explicit `execution: false` disqualifies a node.
  const capable = (nodeId: EnvironmentId): boolean => {
    const node = input.nodes.find((candidate) => candidate.nodeId === nodeId);
    return node?.reachability === "online" && node.capabilities?.execution !== false;
  };
  if (capable(input.originNodeId)) {
    const desk = input.taskDesks.find((candidate) => candidate.nodeId === input.originNodeId);
    const recent = desk?.tasks.find((task) => task.taskRef.executionNodeId === input.originNodeId);
    if (recent !== undefined) return recent.projectRef;
    const local = input.projects.find((project) => project.ref.nodeId === input.originNodeId);
    if (local !== undefined) return local.ref;
  }
  // Any other online, execution-capable node with a project is a valid home.
  return input.projects.find((project) => capable(project.ref.nodeId))?.ref ?? null;
}

export type CirceCommandInputMode = "voice" | "text";

export interface CirceVoiceSubmission {
  readonly captureId: string;
  readonly transcript: string;
  /** Raw ASR text before entity grounding. */
  readonly sourceTranscript?: string;
  /** Allocated once at capture finalization so a manual retry is idempotent. */
  readonly requestId?: string;
  /** Text composer entries share the queue but never trigger speech output. */
  readonly inputMode?: CirceCommandInputMode;
}

export function resolveCirceVoiceProjectChoice(input: {
  readonly instruction: string;
  readonly answer: string;
  readonly candidates: ReadonlyArray<{
    readonly ref: CirceProjectRef;
    readonly title: string;
    readonly label?: string;
  }>;
  readonly acceptsAffirmation?: boolean;
}): {
  readonly instruction: string;
  readonly projectRef: CirceProjectRef;
  /** Answer text the target matcher consumed; leftovers mean a new request. */
  readonly matchedText: string;
} | null {
  const match = resolveCirceProjectChoice({
    answer: input.answer,
    candidates: input.candidates,
    ...(input.acceptsAffirmation === undefined
      ? {}
      : { acceptsAffirmation: input.acceptsAffirmation }),
  });
  const candidate = match === null ? undefined : input.candidates[match.index];
  if (match === null || candidate === undefined) return null;
  return {
    instruction: input.instruction,
    projectRef: candidate.ref,
    matchedText: match.matchedText,
  };
}

export interface CirceVoiceSubmissionQueue {
  readonly enqueue: (
    submission: CirceVoiceSubmission,
  ) => "enqueued" | "duplicate" | "full" | "empty";
  readonly drain: () => Promise<void>;
  readonly resume: (
    captureId: string,
    submission: CirceVoiceSubmission,
  ) => "resumed" | "missing" | "empty";
  readonly discard: (captureId: string) => boolean;
  readonly failed: () => CirceVoiceSubmission | null;
  readonly retryFailed: () => Promise<void>;
  readonly size: () => number;
  readonly clear: () => void;
  readonly isRunning: () => boolean;
  readonly discardWaiting: () => ReadonlyArray<string>;
}

export function isCirceVoiceClarificationDiscard(answer: string): boolean {
  // One shared discard decision for web and mobile clarification answers.
  return isCirceClarificationDiscard(answer);
}

/**
 * Keeps finalized captures independent while one instruction is on the wire.
 * The queue deliberately owns no React state: callers can keep their typed
 * draft and decide when the current catalog is ready to drain it.
 */
export function createCirceVoiceSubmissionQueue(input: {
  readonly submit: (submission: CirceVoiceSubmission) => Promise<void | "complete" | "pause">;
  readonly canSubmit?: () => boolean;
  readonly maxPending?: number;
  readonly onChange?: () => void;
}): CirceVoiceSubmissionQueue {
  const pending: CirceVoiceSubmission[] = [];
  const seenCaptureIds = new Set<string>();
  const seenCaptureOrder: string[] = [];
  const maxPending = Math.max(1, input.maxPending ?? 8);
  let activeDrain: Promise<void> | null = null;
  // A submit can enqueue synchronously (a correction that replaces a paused
  // request). The guard closes before that first await so the reentrant
  // drain() call joins the live drain instead of starting a second loop.
  let draining = false;
  let pausedCaptureId: string | null = null;
  let activeSubmission: CirceVoiceSubmission | null = null;
  let generation = 0;
  const failedSubmissions: CirceVoiceSubmission[] = [];

  const drain = (): Promise<void> => {
    if (
      draining ||
      activeDrain !== null ||
      pausedCaptureId !== null ||
      input.canSubmit?.() === false
    ) {
      return activeDrain ?? Promise.resolve();
    }
    draining = true;
    const drainGeneration = generation;
    activeDrain = (async () => {
      while (
        generation === drainGeneration &&
        pending.length > 0 &&
        input.canSubmit?.() !== false
      ) {
        const submission = pending[0];
        if (submission === undefined) break;
        activeSubmission = submission;
        input.onChange?.();
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
        } finally {
          activeSubmission = null;
          input.onChange?.();
        }
      }
    })().finally(() => {
      draining = false;
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
      // A new utterance supersedes a parked item that can no longer progress.
      // Answer attempts reach the queue through resume(), so reaching here
      // while paused means the parked item has no clarification left to
      // answer (an orphaned pause). Dropping it keeps later captures from
      // being stranded behind it forever.
      if (pausedCaptureId !== null) {
        const pausedIndex = pending.findIndex(
          (candidate) => candidate.captureId === pausedCaptureId,
        );
        if (pausedIndex !== -1) pending.splice(pausedIndex, 1);
        pausedCaptureId = null;
      }
      if (submission.captureId.length > 0) {
        seenCaptureIds.add(submission.captureId);
        seenCaptureOrder.push(submission.captureId);
        while (seenCaptureOrder.length > 128) {
          const expiredCaptureId = seenCaptureOrder.shift();
          if (expiredCaptureId !== undefined) seenCaptureIds.delete(expiredCaptureId);
        }
      }
      pending.push({ ...submission, transcript: submission.transcript.trim() });
      input.onChange?.();
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
      input.onChange?.();
      void drain();
      return "resumed";
    },
    discard: (captureId) => {
      const index = pending.findIndex((candidate) => candidate.captureId === captureId);
      if (index === -1) return false;
      pending.splice(index, 1);
      if (pausedCaptureId === captureId) pausedCaptureId = null;
      input.onChange?.();
      void drain();
      return true;
    },
    failed: () => failedSubmissions[0] ?? null,
    retryFailed: () => {
      const retry = failedSubmissions.shift();
      if (retry === undefined) return Promise.resolve();
      pending.unshift(retry);
      input.onChange?.();
      return drain();
    },
    size: () => pending.length + failedSubmissions.length,
    isRunning: () => activeSubmission !== null,
    discardWaiting: () => {
      const removed = [
        ...pending.filter((item) => item !== activeSubmission),
        ...failedSubmissions,
      ];
      pending.splice(0, pending.length, ...pending.filter((item) => item === activeSubmission));
      failedSubmissions.length = 0;
      pausedCaptureId = null;
      input.onChange?.();
      return removed.map((item) => item.captureId);
    },
    clear: () => {
      generation += 1;
      pending.length = 0;
      seenCaptureIds.clear();
      seenCaptureOrder.length = 0;
      failedSubmissions.length = 0;
      pausedCaptureId = null;
      input.onChange?.();
    },
  };
}

export type CirceDesktopMenuAction = "open-control-center" | "live-voice-toggle";

export function resolveCirceDesktopMenuAction(action: string): CirceDesktopMenuAction | null {
  switch (action) {
    case "circe.toggle":
      return "open-control-center";
    case "circe.live-voice-toggle":
      return "live-voice-toggle";
    default:
      return null;
  }
}

export interface CirceShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat?: boolean;
}

export function circeManagerCatalogIsReady(input: {
  readonly catalogLoaded: boolean;
  readonly catalogPending: boolean;
  readonly catalogError: string | null;
}): boolean {
  return input.catalogLoaded && !input.catalogPending && input.catalogError === null;
}

export function isCirceShortcut(event: CirceShortcutEvent): boolean {
  return (
    event.key.toLowerCase() === "j" &&
    event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.repeat !== true
  );
}

/** Desktop owns the global voice chord; the renderer shortcut is web-only navigation. */
export function shouldHandleCirceShortcutInRenderer(desktop: boolean): boolean {
  return !desktop;
}

export function appendCirceChoice(utterance: string, choice: string): string {
  const instruction = utterance.trim();
  const selection = choice.trim();
  if (instruction.length === 0) return selection;
  if (selection.length === 0) return instruction;
  return `${instruction}\n${selection}`;
}

export function buildCirceRequestMetadata(input: {
  readonly requestId: string;
  readonly originInteractionId: string;
  readonly originNodeId: EnvironmentId | null;
  readonly inputMode?: CirceCommandInputMode;
  readonly sourceUtterance?: string;
}): CirceRequestMetadata {
  // The wire contract only marks voice. Text is the default and stays unmarked
  // so a composer entry never triggers spoken feedback.
  const wireInputMode = input.inputMode === "voice" ? ("voice" as const) : undefined;
  return {
    requestId: input.requestId,
    ...(wireInputMode === undefined ? {} : { inputMode: wireInputMode }),
    // Verbatim span authority: preserve the original transcript byte-for-byte
    // (bounded only), never trim. Span offsets validate against this exact
    // source; trimming would shift every cited range.
    ...(input.sourceUtterance === undefined
      ? {}
      : { sourceUtterance: input.sourceUtterance.slice(0, 16_000) }),
    origin: {
      ...(input.originNodeId === null ? {} : { originNodeId: input.originNodeId }),
      originInteractionId: input.originInteractionId,
    },
  };
}

export function applyCirceClarificationChoice(
  utterance: string,
  clarification: CirceNeedsInput,
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
      return appendCirceChoice(utterance, selection);
  }
}

export type CirceClarificationOrigin = "server" | "client";

export function circeErrorMessage(error: unknown): string {
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
  return "Circe couldn’t start that task. Check the connection and try again.";
}

export type CirceExecutionFeedback = {
  readonly cue: boolean;
  readonly speech: string;
  readonly visual: {
    readonly state: string;
    readonly detail: string;
    readonly kind: string;
  };
};

/** Converts an authoritative Director result into user-facing feedback. */
export function circeExecutionFeedback(result: CirceExecutionResult): CirceExecutionFeedback {
  if (result.status === "needs-input") {
    return {
      cue: false,
      speech: result.prompt,
      visual: { state: "Need one detail", detail: result.prompt, kind: "error" },
    };
  }
  if (result.status === "cancelled") {
    return {
      cue: false,
      speech: "Cancelled before anything was dispatched.",
      visual: {
        state: "Cancelled",
        detail: "Cancelled before anything was dispatched.",
        kind: "cancelled",
      },
    };
  }
  if (result.status === "acknowledged") {
    return {
      cue: false,
      speech: result.message,
      visual: { state: "Circe", detail: result.message, kind: "completed" },
    };
  }
  return {
    cue: false,
    speech: result.acknowledgement ?? "Working on it.",
    visual: { state: "Working on it", detail: result.objective, kind: "started" },
  };
}
