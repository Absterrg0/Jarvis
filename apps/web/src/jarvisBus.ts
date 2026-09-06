import type {
  EnvironmentId,
  JarvisTaskPendingReply,
  JarvisTaskRef,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

const JARVIS_OPEN_EVENT = "t3code:open-jarvis";
const JARVIS_ONBOARDING_EVENT = "t3code:open-jarvis-onboarding";

export interface JarvisCommandTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly taskRef?: JarvisTaskRef;
}

export type JarvisComposerInputMode = "text" | "voice";

export interface JarvisComposerCommand {
  readonly text: string;
  readonly inputMode: JarvisComposerInputMode;
  readonly captureId: string;
  readonly requestId?: string;
  readonly sourceTranscript?: string;
}

type JarvisComposerListener = (command: JarvisComposerCommand) => void;

const jarvisComposerListeners = new Set<JarvisComposerListener>();

export function submitJarvisComposerCommand(command: JarvisComposerCommand): void {
  for (const listener of jarvisComposerListeners) listener(command);
}

export function onJarvisComposerCommand(listener: JarvisComposerListener): () => void {
  jarvisComposerListeners.add(listener);
  return () => {
    jarvisComposerListeners.delete(listener);
  };
}

export interface JarvisCommandFeedback {
  readonly captureId?: string;
  readonly requestId?: string;
  readonly inputMode: JarvisComposerInputMode;
  readonly kind: "working" | "needs-input" | "error" | "done";
  readonly text: string;
}

type JarvisFeedbackListener = (feedback: JarvisCommandFeedback) => void;

const jarvisFeedbackListeners = new Set<JarvisFeedbackListener>();
let jarvisLastFeedback: JarvisCommandFeedback | null = null;

export function publishJarvisCommandFeedback(feedback: JarvisCommandFeedback): void {
  jarvisLastFeedback = feedback;
  for (const listener of jarvisFeedbackListeners) listener(feedback);
}

export function onJarvisCommandFeedback(listener: JarvisFeedbackListener): () => void {
  jarvisFeedbackListeners.add(listener);
  return () => {
    jarvisFeedbackListeners.delete(listener);
  };
}

export function getJarvisLastCommandFeedback(): JarvisCommandFeedback | null {
  return jarvisLastFeedback;
}

export interface JarvisTargetSnapshot {
  readonly projectRef: import("@t3tools/contracts").JarvisProjectRef | null;
  readonly projectTitle?: string;
  readonly nodeLabel?: string;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly referenceThreadId?: ThreadId;
  readonly taskRef?: JarvisTaskRef;
  readonly pendingReply?: JarvisTaskPendingReply | null;
  readonly available: boolean;
}

type JarvisTargetSnapshotListener = (snapshot: JarvisTargetSnapshot | null) => void;

const jarvisTargetSnapshotListeners = new Set<JarvisTargetSnapshotListener>();
let jarvisTargetSnapshot: JarvisTargetSnapshot | null = null;

export function publishJarvisTargetSnapshot(snapshot: JarvisTargetSnapshot | null): void {
  jarvisTargetSnapshot = snapshot;
  for (const listener of jarvisTargetSnapshotListeners) listener(snapshot);
}

export function onJarvisTargetSnapshot(listener: JarvisTargetSnapshotListener): () => void {
  jarvisTargetSnapshotListeners.add(listener);
  return () => {
    jarvisTargetSnapshotListeners.delete(listener);
  };
}

export function getJarvisTargetSnapshot(): JarvisTargetSnapshot | null {
  return jarvisTargetSnapshot;
}

export type JarvisTargetRequest =
  | {
      readonly type: "select-project";
      readonly projectRef: import("@t3tools/contracts").JarvisProjectRef;
      readonly projectTitle?: string;
      readonly nodeLabel?: string;
    }
  | {
      readonly type: "select-task";
      readonly projectRef: import("@t3tools/contracts").JarvisProjectRef;
      readonly threadId: ThreadId;
      readonly title?: string;
      readonly taskRef?: JarvisTaskRef;
      readonly pendingReply?: JarvisTaskPendingReply | null;
      readonly nodeLabel?: string;
    }
  | { readonly type: "clear" };

type JarvisTargetRequestListener = (request: JarvisTargetRequest) => void;

const jarvisTargetRequestListeners = new Set<JarvisTargetRequestListener>();

export function requestJarvisTarget(request: JarvisTargetRequest): void {
  for (const listener of jarvisTargetRequestListeners) listener(request);
}

export function onJarvisTargetRequest(listener: JarvisTargetRequestListener): () => void {
  jarvisTargetRequestListeners.add(listener);
  return () => {
    jarvisTargetRequestListeners.delete(listener);
  };
}

type JarvisPendingListener = (pending: boolean) => void;

const jarvisPendingListeners = new Set<JarvisPendingListener>();
let jarvisCommandPending = false;

export function publishJarvisCommandPending(pending: boolean): void {
  if (jarvisCommandPending === pending) return;
  jarvisCommandPending = pending;
  for (const listener of jarvisPendingListeners) listener(pending);
}

export function onJarvisCommandPending(listener: JarvisPendingListener): () => void {
  jarvisPendingListeners.add(listener);
  return () => {
    jarvisPendingListeners.delete(listener);
  };
}

export function isJarvisCommandPending(): boolean {
  return jarvisCommandPending;
}

type JarvisBusyListener = (busy: boolean) => void;

const jarvisBusyListeners = new Set<JarvisBusyListener>();
let jarvisCommandBusy = false;

/**
 * In-flight submission state, separate from the coarser pending state.
 * Pending covers paused clarification waits; busy is only true while a
 * submission is on the wire. The composer stays sendable while waiting for
 * an answer but never while busy.
 */
export function publishJarvisCommandBusy(busy: boolean): void {
  if (jarvisCommandBusy === busy) return;
  jarvisCommandBusy = busy;
  for (const listener of jarvisBusyListeners) listener(busy);
}

export function onJarvisCommandBusy(listener: JarvisBusyListener): () => void {
  jarvisBusyListeners.add(listener);
  return () => {
    jarvisBusyListeners.delete(listener);
  };
}

export function isJarvisCommandBusy(): boolean {
  return jarvisCommandBusy;
}

/** Test-only reset for the module-level command bus. */
export function resetJarvisCommandBusForTests(): void {
  jarvisComposerListeners.clear();
  jarvisFeedbackListeners.clear();
  jarvisTargetSnapshotListeners.clear();
  jarvisTargetRequestListeners.clear();
  jarvisPendingListeners.clear();
  jarvisBusyListeners.clear();
  jarvisLastFeedback = null;
  jarvisTargetSnapshot = null;
  jarvisCommandPending = false;
  jarvisCommandBusy = false;
}

export function openJarvis(): void {
  window.dispatchEvent(new Event(JARVIS_OPEN_EVENT));
}

export function onOpenJarvis(listener: () => void): () => void {
  window.addEventListener(JARVIS_OPEN_EVENT, listener);
  return () => window.removeEventListener(JARVIS_OPEN_EVENT, listener);
}

/** Open the first-run guide from management or Settings without coupling those surfaces. */
export function openJarvisOnboarding(): void {
  window.dispatchEvent(new Event(JARVIS_ONBOARDING_EVENT));
}

export function onOpenJarvisOnboarding(listener: () => void): () => void {
  window.addEventListener(JARVIS_ONBOARDING_EVENT, listener);
  return () => window.removeEventListener(JARVIS_ONBOARDING_EVENT, listener);
}
