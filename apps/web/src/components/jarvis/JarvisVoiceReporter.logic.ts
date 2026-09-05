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
  cancelBrowserSpeech(deliveryId);
}

interface BrowserSpeechEntry {
  readonly deliveryId: string;
  readonly text: string;
  readonly settle: (outcome: DesktopJarvisVoiceSpeechOutcome) => void;
}

/**
 * One shared lane for the global browser speech singleton across per-node
 * queues. speechSynthesis has its own native FIFO: letting every node queue
 * speak into it directly means a disconnected node's report stays natively
 * queued behind live speech and plays stale afterward, and no ownership
 * flag can retract it. Holding every browser utterance in this lane instead
 * keeps exactly one live utterance at the singleton: clearing a node drops
 * its waiting entries before they ever reach the speaker, cancelling the
 * live entry advances the lane, and ownership transfers as playback ends.
 */
const browserSpeechWaiting: BrowserSpeechEntry[] = [];
let browserSpeechLive: { readonly entry: BrowserSpeechEntry } | null = null;

function browserSpeechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window
  );
}

function advanceBrowserSpeech(): void {
  if (browserSpeechLive !== null) return;
  const next = browserSpeechWaiting.shift();
  if (next === undefined) return;
  if (!browserSpeechSupported()) {
    next.settle({ status: "failed", code: "speech-unavailable" });
    advanceBrowserSpeech();
    return;
  }
  try {
    const utterance = new window.SpeechSynthesisUtterance(next.text);
    utterance.lang = (typeof navigator !== "undefined" ? navigator.language : undefined) || "en-US";
    utterance.rate = 1.03;
    browserSpeechLive = { entry: next };
    utterance.addEventListener(
      "end",
      () => {
        if (browserSpeechLive?.entry !== next) return;
        browserSpeechLive = null;
        next.settle({ status: "played" });
        advanceBrowserSpeech();
      },
      { once: true },
    );
    utterance.addEventListener(
      "error",
      () => {
        if (browserSpeechLive?.entry !== next) return;
        browserSpeechLive = null;
        next.settle({ status: "failed", code: "browser-speech-failed" });
        advanceBrowserSpeech();
      },
      { once: true },
    );
    window.speechSynthesis.speak(utterance);
  } catch {
    if (browserSpeechLive?.entry === next) browserSpeechLive = null;
    next.settle({ status: "failed", code: "browser-speech-failed" });
    advanceBrowserSpeech();
  }
}

export function enqueueBrowserSpeech(
  text: string,
  deliveryId: string,
): Promise<DesktopJarvisVoiceSpeechOutcome> {
  return new Promise<DesktopJarvisVoiceSpeechOutcome>((resolve) => {
    browserSpeechWaiting.push({ deliveryId, text, settle: resolve });
    advanceBrowserSpeech();
  });
}

export function cancelBrowserSpeech(deliveryId: string): void {
  // Waiting entries never reached the singleton: drop and mute them here.
  for (let index = browserSpeechWaiting.length - 1; index >= 0; index -= 1) {
    if (browserSpeechWaiting[index]?.deliveryId === deliveryId) {
      const [removed] = browserSpeechWaiting.splice(index, 1);
      removed?.settle({ status: "deferred", reason: "cancelled" });
    }
  }
  // Only the live delivery may cancel the singleton; another node's clear
  // must not cut off audible speech it does not own.
  const live = browserSpeechLive;
  if (live?.entry.deliveryId === deliveryId) {
    browserSpeechLive = null;
    live.entry.settle({ status: "deferred", reason: "cancelled" });
    try {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    } catch {
      // Browser speech may be unavailable; the lane already advanced below.
    }
    // The cancel error event arrives muted by the ownership check above,
    // so advance here instead of waiting for it.
    advanceBrowserSpeech();
  }
}

/** Live plus waiting browser utterances; tests assert this drains to zero. */
export function browserSpeechQueueSize(): number {
  return browserSpeechWaiting.length + (browserSpeechLive === null ? 0 : 1);
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
