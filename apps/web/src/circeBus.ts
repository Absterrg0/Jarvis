import type {
  EnvironmentId,
  CirceTaskPendingReply,
  CirceTaskRef,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

const CIRCE_OPEN_EVENT = "t3code:open-circe";

export interface CirceCommandTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly taskRef?: CirceTaskRef;
}

export type CirceComposerInputMode = "text" | "voice";

export interface CirceComposerCommand {
  readonly text: string;
  readonly inputMode: CirceComposerInputMode;
  readonly captureId: string;
  readonly requestId?: string;
  readonly sourceTranscript?: string;
}

type CirceComposerListener = (command: CirceComposerCommand) => void;

const circeComposerListeners = new Set<CirceComposerListener>();

export function submitCirceComposerCommand(command: CirceComposerCommand): void {
  for (const listener of circeComposerListeners) listener(command);
}

export function onCirceComposerCommand(listener: CirceComposerListener): () => void {
  circeComposerListeners.add(listener);
  return () => {
    circeComposerListeners.delete(listener);
  };
}

export interface CirceCommandFeedback {
  readonly captureId?: string;
  readonly requestId?: string;
  readonly inputMode: CirceComposerInputMode;
  readonly kind: "working" | "needs-input" | "error" | "done";
  readonly text: string;
}

type CirceFeedbackListener = (feedback: CirceCommandFeedback) => void;

const circeFeedbackListeners = new Set<CirceFeedbackListener>();
let circeLastFeedback: CirceCommandFeedback | null = null;

export function publishCirceCommandFeedback(feedback: CirceCommandFeedback): void {
  circeLastFeedback = feedback;
  for (const listener of circeFeedbackListeners) listener(feedback);
}

export function onCirceCommandFeedback(listener: CirceFeedbackListener): () => void {
  circeFeedbackListeners.add(listener);
  return () => {
    circeFeedbackListeners.delete(listener);
  };
}

export function getCirceLastCommandFeedback(): CirceCommandFeedback | null {
  return circeLastFeedback;
}

export interface CirceTargetSnapshot {
  readonly projectRef: import("@t3tools/contracts").CirceProjectRef | null;
  readonly projectTitle?: string;
  readonly nodeLabel?: string;
  /** Bounded recent-work summary so the voice model knows what exists. */
  readonly recentTasks?: ReadonlyArray<{
    readonly title: string;
    readonly project?: string;
    readonly state?: string;
  }>;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly referenceThreadId?: ThreadId;
  readonly taskRef?: CirceTaskRef;
  readonly pendingReply?: CirceTaskPendingReply | null;
  readonly available: boolean;
}

type CirceTargetSnapshotListener = (snapshot: CirceTargetSnapshot | null) => void;

const circeTargetSnapshotListeners = new Set<CirceTargetSnapshotListener>();
let circeTargetSnapshot: CirceTargetSnapshot | null = null;

export function publishCirceTargetSnapshot(snapshot: CirceTargetSnapshot | null): void {
  circeTargetSnapshot = snapshot;
  for (const listener of circeTargetSnapshotListeners) listener(snapshot);
}

export function onCirceTargetSnapshot(listener: CirceTargetSnapshotListener): () => void {
  circeTargetSnapshotListeners.add(listener);
  return () => {
    circeTargetSnapshotListeners.delete(listener);
  };
}

export function getCirceTargetSnapshot(): CirceTargetSnapshot | null {
  return circeTargetSnapshot;
}

export type CirceTargetRequest =
  | {
      readonly type: "select-project";
      readonly projectRef: import("@t3tools/contracts").CirceProjectRef;
      readonly projectTitle?: string;
      readonly nodeLabel?: string;
    }
  | {
      readonly type: "select-task";
      readonly projectRef: import("@t3tools/contracts").CirceProjectRef;
      readonly threadId: ThreadId;
      readonly title?: string;
      readonly taskRef?: CirceTaskRef;
      readonly pendingReply?: CirceTaskPendingReply | null;
      readonly nodeLabel?: string;
    }
  | { readonly type: "clear" };

type CirceTargetRequestListener = (request: CirceTargetRequest) => void;

const circeTargetRequestListeners = new Set<CirceTargetRequestListener>();

export function requestCirceTarget(request: CirceTargetRequest): void {
  for (const listener of circeTargetRequestListeners) listener(request);
}

export function onCirceTargetRequest(listener: CirceTargetRequestListener): () => void {
  circeTargetRequestListeners.add(listener);
  return () => {
    circeTargetRequestListeners.delete(listener);
  };
}

/** Runtime-owned interaction state; displayed feedback never grants action authority. */
export interface CirceCommandState {
  readonly pending: boolean;
  readonly busy: boolean;
  readonly awaitingAnswer: boolean;
  readonly canRetry: boolean;
}

const idleCommandState: CirceCommandState = {
  pending: false,
  busy: false,
  awaitingAnswer: false,
  canRetry: false,
};
let circeCommandState = idleCommandState;
const circeCommandStateListeners = new Set<(state: CirceCommandState) => void>();

export function publishCirceCommandState(state: CirceCommandState): void {
  if (
    state.pending === circeCommandState.pending &&
    state.busy === circeCommandState.busy &&
    state.awaitingAnswer === circeCommandState.awaitingAnswer &&
    state.canRetry === circeCommandState.canRetry
  )
    return;
  circeCommandState = state;
  for (const listener of circeCommandStateListeners) listener(state);
}

export function getCirceCommandState(): CirceCommandState {
  return circeCommandState;
}
export function isCirceCommandPending(): boolean {
  return circeCommandState.pending;
}
export function isCirceCommandBusy(): boolean {
  return circeCommandState.busy;
}
export function onCirceCommandState(listener: (state: CirceCommandState) => void): () => void {
  circeCommandStateListeners.add(listener);
  return () => {
    circeCommandStateListeners.delete(listener);
  };
}

export type CirceCommandAction = {
  readonly type: "cancel" | "retry";
  readonly inputMode: CirceComposerInputMode;
};
const circeCommandActionListeners = new Set<(action: CirceCommandAction) => void>();
export function requestCirceCommandAction(action: CirceCommandAction): void {
  for (const listener of circeCommandActionListeners) listener(action);
}
export function onCirceCommandAction(listener: (action: CirceCommandAction) => void): () => void {
  circeCommandActionListeners.add(listener);
  return () => {
    circeCommandActionListeners.delete(listener);
  };
}

/** Test-only reset for the module-level command bus. */
export function resetCirceCommandBusForTests(): void {
  circeComposerListeners.clear();
  circeSpeechInterruptListeners.clear();
  circeReportInterruptListeners.clear();
  circeSpeechTerminalListeners.clear();
  circeFeedbackListeners.clear();
  circeTargetSnapshotListeners.clear();
  circeTargetRequestListeners.clear();
  circeCommandStateListeners.clear();
  circeCommandActionListeners.clear();
  circeLastFeedback = null;
  circeTargetSnapshot = null;
  circeCommandState = idleCommandState;
}

type CirceSpeechInterruptListener = () => void;

const circeSpeechInterruptListeners = new Set<CirceSpeechInterruptListener>();

/**
 * A new capture takes the floor: the command runtime retracts its owned
 * interaction speech. Capture surfaces call this on start; the runtime
 * owns the retraction. Provider work is never touched by this action.
 */
export function interruptCirceInteractionSpeech(): void {
  for (const listener of circeSpeechInterruptListeners) listener();
}

export function onInterruptCirceInteractionSpeech(
  listener: CirceSpeechInterruptListener,
): () => void {
  circeSpeechInterruptListeners.add(listener);
  return () => {
    circeSpeechInterruptListeners.delete(listener);
  };
}

type CirceReportInterruptListener = () => void;

const circeReportInterruptListeners = new Set<CirceReportInterruptListener>();

/**
 * A new capture or a terminal pre-accept outcome takes the floor from live
 * report speech too: queued reports are dropped and the in-flight utterance
 * is retracted. Durable task state is untouched; only spoken delivery stops.
 */
export function interruptCirceReportSpeech(): void {
  for (const listener of circeReportInterruptListeners) listener();
}

export function onInterruptCirceReportSpeech(listener: CirceReportInterruptListener): () => void {
  circeReportInterruptListeners.add(listener);
  return () => {
    circeReportInterruptListeners.delete(listener);
  };
}

/**
 * One finished server turn for cross-lane speech relevance. The report lane
 * publishes the terminal's taskRef, threadId, and turnId; the interaction
 * lane vetoes the same turn's delayed ack either order. Fire-and-forget:
 * no delivery ledger, election, acknowledgement, or replay. Native desktop
 * interaction speech without a deliveryId subscribes here to retract its
 * live utterance; the browser lane is already retracted through the shared
 * registry.
 */
export interface CirceSpeechTerminalEvent {
  readonly threadId: ThreadId;
  readonly taskRef?: CirceTaskRef;
  readonly turnId?: TurnId;
  readonly requestId?: string;
}

type CirceSpeechTerminalListener = (event: CirceSpeechTerminalEvent) => void;

const circeSpeechTerminalListeners = new Set<CirceSpeechTerminalListener>();

export function publishCirceSpeechTerminal(event: CirceSpeechTerminalEvent): void {
  for (const listener of circeSpeechTerminalListeners) listener(event);
}

export function onCirceSpeechTerminal(listener: CirceSpeechTerminalListener): () => void {
  circeSpeechTerminalListeners.add(listener);
  return () => {
    circeSpeechTerminalListeners.delete(listener);
  };
}

export function openCirce(): void {
  window.dispatchEvent(new Event(CIRCE_OPEN_EVENT));
}

export function onOpenCirce(listener: () => void): () => void {
  window.addEventListener(CIRCE_OPEN_EVENT, listener);
  return () => window.removeEventListener(CIRCE_OPEN_EVENT, listener);
}
