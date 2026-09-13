import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type CircePresentationEvent,
  type CirceTaskRef,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { selectSpokenSummary } from "@circe/core/spokenSummary";

/** Local speech delivery result. Live sessions report played without a lane. */
export type CirceSpeechOutcome =
  | { readonly status: "played" }
  | { readonly status: "failed"; readonly code: string }
  | { readonly status: "deferred"; readonly reason: string };

export function canMountCirceVoiceReporter(
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

export function spokenPresentationText(event: CircePresentationEvent): string {
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

export function presentationStatus(event: CircePresentationEvent): {
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

export function enqueueCircePresentation(
  queue: Promise<void>,
  task: () => Promise<void>,
): Promise<void> {
  return queue.then(task);
}

/** Cancel in-flight speech on the browser lane. */
export function cancelCirceSpeechDelivery(deliveryId: string): void {
  cancelBrowserSpeech(deliveryId);
}

interface BrowserSpeechEntry {
  readonly deliveryId: string;
  readonly text: string;
  readonly settle: (outcome: CirceSpeechOutcome) => void;
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
): Promise<CirceSpeechOutcome> {
  return new Promise<CirceSpeechOutcome>((resolve) => {
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

/**
 * Cross-lane terminal notice: one finished server turn of one thread.
 * Carried on the speech bus so the interaction lane can veto the same
 * turn's delayed ack. Fire-and-forget: no delivery ledger, election,
 * acknowledgement, or replay. Thread identity stays node-qualified through
 * the taskRef; turnId scopes the exact turn.
 */
export interface CirceSpeechTerminalNotice {
  readonly threadId: ThreadId;
  readonly taskRef?: CirceTaskRef;
  readonly turnId?: TurnId;
  readonly requestId?: string;
}

const MAX_SHARED_TERMINAL_TURNS = 256;
const MAX_SHARED_REQUEST_TURNS = 128;
const MAX_SHARED_TERMINAL_REQUESTS = 256;
const MAX_LIVE_INTERACTION_SPEECH = 64;

const sharedTerminalTurns = new Set<string>();
const sharedRequestTurns = new Map<string, string>();
const sharedTerminalRequests = new Set<string>();
const liveInteractionSpeech = new Map<
  string,
  {
    readonly turnKey: string | null;
    readonly threadKey: string | null;
    readonly requestId?: string;
  }
>();

/** Node-qualified thread identity shared by both speech lanes. */
export function circeSpeechThreadKey(input: {
  readonly taskRef?: CirceTaskRef;
  readonly threadId: ThreadId;
  readonly threadKey?: string;
  readonly turnId?: TurnId;
  readonly requestId?: string;
}): string {
  return input.taskRef === undefined
    ? `:${input.threadId}`
    : `${input.taskRef.executionNodeId}:${input.threadId}`;
}

function sharedTurnKey(threadKey: string, turnId: TurnId): string {
  return `${threadKey}:${turnId}`;
}

function sharedRequestKey(threadKey: string, requestId: string): string {
  return `${threadKey}:${requestId}`;
}

function rememberSharedTerminal(turnKey: string): void {
  sharedTerminalTurns.add(turnKey);
  if (sharedTerminalTurns.size > MAX_SHARED_TERMINAL_TURNS) {
    const oldest = sharedTerminalTurns.values().next();
    if (!oldest.done) sharedTerminalTurns.delete(oldest.value);
  }
}

function rememberSharedTerminalRequest(requestKey: string): void {
  sharedTerminalRequests.add(requestKey);
  if (sharedTerminalRequests.size > MAX_SHARED_TERMINAL_REQUESTS) {
    const oldest = sharedTerminalRequests.values().next();
    if (!oldest.done) sharedTerminalRequests.delete(oldest.value);
  }
}

/**
 * Link one accepted request to its server turn. The interaction lane calls
 * this when speaking an ack that carries both, so a terminal arriving for
 * that turn also vetoes turn-less prompts sharing the request.
 */
export function noteCirceSpeechRequestTurn(
  requestId: string,
  input: { readonly taskRef?: CirceTaskRef; readonly threadId: ThreadId; readonly turnId: TurnId },
): void {
  sharedRequestTurns.set(requestId, sharedTurnKey(circeSpeechThreadKey(input), input.turnId));
  if (sharedRequestTurns.size > MAX_SHARED_REQUEST_TURNS) {
    const oldest = sharedRequestTurns.keys().next();
    if (!oldest.done) sharedRequestTurns.delete(oldest.value);
  }
}

/**
 * Record one terminal turn and take the live interaction deliveries that
 * belong to it. Callers cancel each returned deliveryId on their own
 * adapter; the browser lane cancel lives in this module so the report queue
 * can retract browser speech without reaching into another queue.
 */
export function noteCirceSpeechTerminal(notice: CirceSpeechTerminalNotice): string[] {
  if (notice.turnId !== undefined) {
    const threadKey = circeSpeechThreadKey(notice);
    const turnKey = sharedTurnKey(threadKey, notice.turnId);
    rememberSharedTerminal(turnKey);
    if (notice.requestId !== undefined) {
      rememberSharedTerminalRequest(sharedRequestKey(threadKey, notice.requestId));
    }
    const stale: string[] = [];
    for (const [deliveryId, live] of liveInteractionSpeech) {
      if (live.turnKey === turnKey) {
        stale.push(deliveryId);
        liveInteractionSpeech.delete(deliveryId);
      } else if (
        notice.requestId !== undefined &&
        live.requestId === notice.requestId &&
        live.threadKey === threadKey
      ) {
        stale.push(deliveryId);
        liveInteractionSpeech.delete(deliveryId);
      }
    }
    return stale;
  }
  if (notice.requestId !== undefined) {
    const threadKey = circeSpeechThreadKey(notice);
    rememberSharedTerminalRequest(sharedRequestKey(threadKey, notice.requestId));
    const stale: string[] = [];
    for (const [deliveryId, live] of liveInteractionSpeech) {
      if (live.requestId === notice.requestId && live.threadKey === threadKey) {
        stale.push(deliveryId);
        liveInteractionSpeech.delete(deliveryId);
      }
    }
    return stale;
  }
  return [];
}

/** True once the exact turn's terminal has been noted, either order. */
export function isCirceSpeechTurnTerminal(input: {
  readonly taskRef?: CirceTaskRef;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}): boolean {
  return sharedTerminalTurns.has(sharedTurnKey(circeSpeechThreadKey(input), input.turnId));
}

/**
 * Pre-speak relevance for one interaction ack. A terminal outranks its own
 * turn's delayed ack no matter which arrived first; later turns (different
 * turnId) on the same task stay speakable. Turn-less prompts use the
 * request linkage when their request was accepted with a turn.
 */
export function isCirceSpeechRequestStale(input: {
  readonly threadKey?: string;
  readonly taskRef?: CirceTaskRef;
  readonly threadId?: ThreadId;
  readonly turnId?: TurnId;
  readonly requestId?: string;
}): boolean {
  const threadKey =
    input.threadKey ??
    (input.threadId === undefined
      ? undefined
      : circeSpeechThreadKey({
          ...(input.taskRef === undefined ? {} : { taskRef: input.taskRef }),
          threadId: input.threadId,
        }));
  if (input.turnId !== undefined && threadKey !== undefined) {
    if (sharedTerminalTurns.has(sharedTurnKey(threadKey, input.turnId))) return true;
  }
  if (input.requestId !== undefined) {
    if (
      threadKey !== undefined &&
      sharedTerminalRequests.has(sharedRequestKey(threadKey, input.requestId))
    )
      return true;
    const linked = sharedRequestTurns.get(input.requestId);
    if (linked !== undefined && sharedTerminalTurns.has(linked)) return true;
  }
  return false;
}

/** Track one live interaction utterance so a terminal can retract it. */
export function registerCirceInteractionSpeech(
  deliveryId: string,
  input: {
    readonly threadKey?: string;
    readonly taskRef?: CirceTaskRef;
    readonly threadId?: ThreadId;
    readonly turnId?: TurnId;
    readonly requestId?: string;
  },
): void {
  const threadKey =
    input.threadKey ??
    (input.threadId === undefined
      ? undefined
      : circeSpeechThreadKey({
          ...(input.taskRef === undefined ? {} : { taskRef: input.taskRef }),
          threadId: input.threadId,
        }));
  liveInteractionSpeech.set(deliveryId, {
    turnKey:
      threadKey !== undefined && input.turnId !== undefined
        ? sharedTurnKey(threadKey, input.turnId)
        : null,
    threadKey: threadKey ?? null,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
  if (liveInteractionSpeech.size > MAX_LIVE_INTERACTION_SPEECH) {
    const oldest = liveInteractionSpeech.keys().next();
    if (!oldest.done) liveInteractionSpeech.delete(oldest.value);
  }
}

export function unregisterCirceInteractionSpeech(deliveryId: string): void {
  liveInteractionSpeech.delete(deliveryId);
}

/** Test-only reset for the module-level speech relevance. */
export function resetCirceSpeechRelevanceForTests(): void {
  sharedTerminalTurns.clear();
  sharedRequestTurns.clear();
  sharedTerminalRequests.clear();
  liveInteractionSpeech.clear();
}

export interface CirceSpeechPlaybackQueue {
  readonly enqueue: (presentation: CircePresentationEvent) => void;
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
 * only spoken delivery is queued here. Terminals (completed/failed)
 * outrank their own turn's prompts independent of arrival order via the
 * existing turnId; a later legitimate turn (different turnId) stays
 * speakable on the same task. No second queue or durable ledger here.
 */
export function createCirceSpeechPlaybackQueue(input: {
  readonly speak: (presentation: CircePresentationEvent) => Promise<CirceSpeechOutcome>;
  readonly cancel: (presentation: CircePresentationEvent) => void;
  readonly shouldDeliver?: () => boolean;
  readonly maxPending?: number;
  readonly onDeliveryFailure?: () => void;
  /**
   * Fired once per terminal presentation with its taskRef, threadId, turnId,
   * and exact requestId so the reporter can publish the cross-lane bus
   * notice. Speech only: the task keeps its durable result.
   */
  readonly onTerminal?: (notice: CirceSpeechTerminalNotice) => void;
}): CirceSpeechPlaybackQueue {
  const pending: CircePresentationEvent[] = [];
  const maxPending = Math.max(1, input.maxPending ?? 8);
  // Terminals seen per task turn through thread plus turnId, plus the exact
  // execute requestId carried on the presentation for terminal-before-ack.
  // Request scope stays node/task qualified, never a global id.
  // No verb or text inspection here.
  const terminalTurns = new Set<string>();
  const terminalRequests = new Set<string>();
  const requestTurns = new Map<string, string>();
  let inFlight: {
    readonly presentation: CircePresentationEvent;
    readonly release: () => void;
  } | null = null;
  let pumping: Promise<void> | null = null;
  let generation = 0;

  const threadKeyFor = (presentation: CircePresentationEvent): string =>
    presentation.taskRef === undefined
      ? `:${presentation.threadId}`
      : `${presentation.taskRef.executionNodeId}:${presentation.threadId}`;
  const turnKeyFor = (presentation: CircePresentationEvent): string =>
    `${threadKeyFor(presentation)}:${presentation.turnId ?? presentation.presentationId}`;
  const requestKeyFor = (presentation: CircePresentationEvent): string | null =>
    presentation.requestId === undefined
      ? null
      : `${threadKeyFor(presentation)}:${presentation.requestId}`;
  const isTerminalPresentation = (presentation: CircePresentationEvent): boolean =>
    presentation.kind === "completed" || presentation.kind === "failed";

  const isStalePresentation = (presentation: CircePresentationEvent): boolean => {
    if (isTerminalPresentation(presentation)) return false;
    if (terminalTurns.has(turnKeyFor(presentation))) return true;
    const requestKey = requestKeyFor(presentation);
    if (requestKey !== null) {
      if (terminalRequests.has(requestKey)) return true;
      const linkedTurn = requestTurns.get(requestKey);
      if (linkedTurn !== undefined && terminalTurns.has(linkedTurn)) return true;
    }
    if (
      presentation.turnId !== undefined &&
      isCirceSpeechTurnTerminal({
        ...(presentation.taskRef === undefined ? {} : { taskRef: presentation.taskRef }),
        threadId: presentation.threadId,
        turnId: presentation.turnId,
      })
    ) {
      return true;
    }
    if (
      presentation.requestId !== undefined &&
      isCirceSpeechRequestStale({
        ...(presentation.taskRef === undefined ? {} : { taskRef: presentation.taskRef }),
        threadId: presentation.threadId,
        ...(presentation.turnId === undefined ? {} : { turnId: presentation.turnId }),
        requestId: presentation.requestId,
      })
    ) {
      return true;
    }
    return false;
  };

  const pump = (): void => {
    if (pumping !== null) return;
    pumping = (async () => {
      for (;;) {
        const pumpGeneration = generation;
        const next = pending.shift();
        if (next === undefined || pumpGeneration !== generation) break;
        // Pre-synthesis relevance: a prompt whose turn terminal already
        // arrived never goes audible, no matter which arrived first.
        if (isStalePresentation(next)) continue;
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
              (): { tag: "settled"; outcome: CirceSpeechOutcome } => ({
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
      const turnKey = turnKeyFor(presentation);
      const requestKey = requestKeyFor(presentation);
      if (isTerminalPresentation(presentation)) {
        terminalTurns.add(turnKey);
        if (requestKey !== null) {
          terminalRequests.add(requestKey);
          if (presentation.turnId !== undefined) requestTurns.set(requestKey, turnKey);
        }
        // Share the terminal cross-lane: a delayed interaction ack for the
        // same turn must never go audible, either order. Retract live
        // browser interaction utterances for this turn here.
        if (presentation.turnId !== undefined || presentation.requestId !== undefined) {
          for (const deliveryId of noteCirceSpeechTerminal({
            threadId: presentation.threadId,
            ...(presentation.taskRef === undefined ? {} : { taskRef: presentation.taskRef }),
            ...(presentation.turnId === undefined ? {} : { turnId: presentation.turnId }),
            ...(presentation.requestId === undefined ? {} : { requestId: presentation.requestId }),
          })) {
            cancelBrowserSpeech(deliveryId);
          }
          input.onTerminal?.({
            threadId: presentation.threadId,
            ...(presentation.taskRef === undefined ? {} : { taskRef: presentation.taskRef }),
            ...(presentation.turnId === undefined ? {} : { turnId: presentation.turnId }),
            ...(presentation.requestId === undefined ? {} : { requestId: presentation.requestId }),
          });
        }
        // A terminal retires its own turn's queued prompts before any
        // preparation starts; other turns and threads keep their reports.
        // Invalidation is speech-only: the task keeps its durable result.
        // Request scope is node/task qualified: an unrelated origin on the
        // same task (different requestId) keeps its reports.
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          const queued = pending[index];
          if (queued === undefined || isTerminalPresentation(queued)) continue;
          const queuedTurnKey = turnKeyFor(queued);
          const queuedRequestKey = requestKeyFor(queued);
          if (queuedTurnKey === turnKey) {
            pending.splice(index, 1);
          } else if (requestKey !== null && queuedRequestKey === requestKey) {
            pending.splice(index, 1);
          } else if (queuedRequestKey !== null && requestTurns.get(queuedRequestKey) === turnKey) {
            pending.splice(index, 1);
          }
        }
        // Preempt a live prompt for the same turn so late audio never plays;
        // unrelated threads keep playing through their own ownership.
        const live = inFlight?.presentation;
        if (live !== undefined && !isTerminalPresentation(live)) {
          const liveTurnKey = turnKeyFor(live);
          const liveRequestKey = requestKeyFor(live);
          if (
            liveTurnKey === turnKey ||
            (requestKey !== null && liveRequestKey === requestKey) ||
            (liveRequestKey !== null && requestTurns.get(liveRequestKey) === turnKey)
          ) {
            const stuck = inFlight;
            inFlight = null;
            stuck?.release();
            try {
              if (stuck !== null) input.cancel(stuck.presentation);
            } catch {
              // Cancellation is best-effort; the release already advances.
            }
          }
        }
      } else if (
        terminalTurns.has(turnKey) ||
        (requestKey !== null && terminalRequests.has(requestKey)) ||
        (requestKey !== null &&
          requestTurns.get(requestKey) !== undefined &&
          terminalTurns.has(requestTurns.get(requestKey) as string)) ||
        isStalePresentation(presentation)
      ) {
        // A prompt arriving after its turn terminal never goes audible,
        // no matter which arrived first. Later turns (different turnId)
        // stay speakable on the same task.
        return;
      } else {
        if (requestKey !== null && presentation.turnId !== undefined) {
          requestTurns.set(requestKey, turnKey);
        }
        // Newer prompts supersede older queued prompts for the same turn;
        // other turns keep their reports for later legitimate playback.
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          const queued = pending[index];
          if (
            queued !== undefined &&
            !isTerminalPresentation(queued) &&
            turnKeyFor(queued) === turnKey
          ) {
            pending.splice(index, 1);
          }
        }
      }
      pending.push(presentation);
      // Stale reports give way to newer ones; the task itself keeps the result.
      while (pending.length > maxPending) pending.shift();
      pump();
    },
    clear: () => {
      generation += 1;
      pending.length = 0;
      terminalTurns.clear();
      terminalRequests.clear();
      requestTurns.clear();
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
