import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type DesktopJarvisVoiceSpeechOutcome,
  type JarvisPresentationEvent,
} from "@t3tools/contracts";
import { selectSpokenSummary } from "@t3tools/jarvis-core/spokenSummary";

export function canMountJarvisVoiceReporter(
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
): boolean {
  return (
    session?.authenticated === true &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true
  );
}

function conciseSpeechText(text: string, maximum = 460): string {
  return selectSpokenSummary(text, maximum);
}

export function spokenPresentationText(event: JarvisPresentationEvent): string {
  const output = conciseSpeechText(event.text);
  switch (event.kind) {
    case "waiting-for-input":
      return output.length > 0 ? `I need one quick detail. ${output}` : "I need one quick detail.";
    case "approval-needed":
      return output.length > 0
        ? `Quick check before I continue. ${output}`
        : "Quick check before I continue.";
    case "failed":
      return output.length > 0
        ? `I hit a snag. ${output}`
        : "I hit a snag. I am waiting for your direction.";
    case "completed":
      return output.length > 0
        ? output
        : "I've finished the task. The details are waiting in your workspace.";
  }
}

export function presentationStatus(event: JarvisPresentationEvent): {
  readonly state: string;
  readonly detail: string;
  readonly kind: "completed" | "attention" | "error";
} {
  const detail = conciseSpeechText(event.text);
  switch (event.kind) {
    case "completed":
      return { state: "Finished", detail, kind: "completed" };
    case "waiting-for-input":
      return { state: "I need your input", detail, kind: "attention" };
    case "approval-needed":
      return { state: "One quick approval", detail, kind: "attention" };
    case "failed":
      return { state: "I hit a snag", detail, kind: "error" };
  }
}

/** Keep duplicate live frames from speaking twice during one mounted session. */
export function rememberBoundedPresentationId(
  ids: Set<string>,
  presentationId: string,
  limit = 512,
): boolean {
  if (ids.has(presentationId)) return false;
  ids.add(presentationId);
  while (ids.size > limit) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
  return true;
}

export function enqueueJarvisPresentation(
  queue: Promise<void>,
  task: () => Promise<void>,
): Promise<void> {
  return queue.then(task);
}

/** Cancel in-flight speech on every platform adapter, not just desktop. */
export function cancelJarvisSpeechDelivery(deliveryId: string): void {
  try {
    void window.desktopBridge?.jarvisVoice?.cancelSpeech(deliveryId).catch(() => undefined);
  } catch {
    // A broken native IPC path must not block browser speech cancellation.
  }
  try {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  } catch {
    // Browser speech may be unavailable; desktop cancellation still stands.
  }
}

export interface JarvisSpeechPlaybackQueue {
  readonly enqueue: (presentation: JarvisPresentationEvent) => void;
  /** Drop pending reports and cancel the in-flight one. */
  readonly clear: () => void;
  readonly size: () => number;
}

/**
 * Bounded ephemeral speech queue with one cancellable platform adapter.
 * Reports are live-only: disconnect, disable, or unmount clears obsolete
 * queued work instead of speaking stale results on reconnect, and a
 * never-settling playback cannot stall later reports behind it once the
 * generation moves on. Durable approvals and task results are untouched;
 * only spoken delivery is queued here.
 */
export function createJarvisSpeechPlaybackQueue(input: {
  readonly speak: (
    presentation: JarvisPresentationEvent,
  ) => Promise<DesktopJarvisVoiceSpeechOutcome>;
  readonly cancel: (presentation: JarvisPresentationEvent) => void;
  readonly shouldDeliver?: () => boolean;
  readonly maxPending?: number;
  readonly onDeliveryFailure?: () => void;
}): JarvisSpeechPlaybackQueue {
  const pending: JarvisPresentationEvent[] = [];
  const maxPending = Math.max(1, input.maxPending ?? 8);
  let inFlight: {
    readonly presentation: JarvisPresentationEvent;
    readonly release: () => void;
  } | null = null;
  let pumping: Promise<void> | null = null;
  let generation = 0;

  const pump = (): void => {
    if (pumping !== null) return;
    pumping = (async () => {
      for (;;) {
        const pumpGeneration = generation;
        const next = pending.shift();
        if (next === undefined || pumpGeneration !== generation) break;
        if (input.shouldDeliver?.() === false) continue;
        let releaseInvalidation!: () => void;
        const invalidated = new Promise<"invalidated">((resolve) => {
          releaseInvalidation = () => resolve("invalidated");
        });
        inFlight = { presentation: next, release: releaseInvalidation };
        try {
          // A playback that never settles must not wedge the pump: clear()
          // releases this race, so a later report starts immediately while
          // the stale speak promise is muted by the generation check below.
          const result = await Promise.race([
            input.speak(next).then(
              (outcome) => ({ tag: "settled" as const, outcome }),
              (): { tag: "settled"; outcome: DesktopJarvisVoiceSpeechOutcome } => ({
                tag: "settled",
                outcome: { status: "failed", code: "speech-delivery-failed" },
              }),
            ),
            invalidated.then(() => ({ tag: "invalidated" as const })),
          ]);
          if (pumpGeneration !== generation || result.tag === "invalidated") break;
          if (result.outcome.status === "failed") input.onDeliveryFailure?.();
        } finally {
          if (inFlight?.presentation === next) inFlight = null;
        }
      }
    })().finally(() => {
      pumping = null;
      if (pending.length > 0) pump();
    });
  };

  return {
    enqueue: (presentation) => {
      if (
        inFlight?.presentation.presentationId === presentation.presentationId ||
        pending.some((queued) => queued.presentationId === presentation.presentationId)
      ) {
        return;
      }
      pending.push(presentation);
      // Stale reports give way to newer ones; the task itself keeps the result.
      while (pending.length > maxPending) pending.shift();
      pump();
    },
    clear: () => {
      generation += 1;
      pending.length = 0;
      const stuck = inFlight;
      inFlight = null;
      // Release the race first so the pump can leave a never-settling
      // playback; adapter cancellation is best-effort after that.
      stuck?.release();
      if (stuck !== null) {
        try {
          input.cancel(stuck.presentation);
        } catch {
          // Cancellation is best-effort; the generation bump already mutes it.
        }
      }
    },
    size: () => pending.length + (inFlight === null ? 0 : 1),
  };
}
