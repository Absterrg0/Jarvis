import type { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";

/**
 * One speakable ack with the identity playback needs. Presentations carry
 * their real presentationId, thread, and turnId; execute acks (started
 * acknowledgement, clarification prompt, failure) carry the turn requestId
 * plus outcome so a retry never collides with the attempt it replaces, and
 * the accepted turnId once the integration lane provides it.
 */
export type MobileSpeechRequest = {
  readonly text: string;
  readonly nodeId: EnvironmentId;
  readonly speechKey: string;
  /**
   * `${executionNodeId}:${threadId}` for task-bound speech, "" for
   * untargeted speech (project-free conversation, threadless prompts).
   * The empty lane is still latest-wins: new input supersedes stale audio.
   */
  readonly threadKey: string;
  /**
   * Accepted server turn identity. Primary correlation key with threadKey:
   * a terminal outranks its own turn's ack independent of arrival order,
   * and a later legitimate turn (different turnId) stays speakable on the
   * same task. Consumed when the integration lane provides it on the
   * started result; absent pre-accept and on prompts without a turn.
   */
  readonly turnId?: TurnId;
  /**
   * Exact execute request identity. Pre-accept fallback: retries reuse one
   * requestId, and a turn-less queued prompt links to its turn once an
   * arrive carrying both requestId and turnId is seen.
   */
  readonly requestId?: string;
  /**
   * Client interaction that produced this turn. Retained for diagnostics
   * only: one origin may be reused across later legitimate turns, so it
   * never decides staleness.
   */
  readonly originInteractionId?: string;
  /**
   * True for task terminals (completed/failed presentations). Terminals never
   * go stale behind a later ack; acks go stale behind their own turn's
   * terminal no matter which arrived first. No verb or text inspection here:
   * the composed ack lane owns wording, this gate only owns relevance.
   */
  readonly terminal?: boolean;
};

/** Task identity for one thread on its execution node. */
export function mobileSpeechThreadKey(executionNodeId: EnvironmentId, threadId: ThreadId): string {
  return `${executionNodeId}:${threadId}`;
}

const MAX_SEEN_SPEECH_KEYS = 128;
const MAX_TRACKED_THREADS = 64;
const MAX_TERMINAL_TURNS = 256;
const MAX_REQUEST_TURNS = 128;
const MAX_TERMINAL_REQUESTS = 256;

type SpeechIdentity = Pick<
  MobileSpeechRequest,
  "speechKey" | "threadKey" | "turnId" | "requestId" | "terminal"
>;

/** Exact turn scope: one server turn of one thread on its execution node. */
export function mobileSpeechTurnKey(threadKey: string, turnId: TurnId): string {
  return `${threadKey}:${turnId}`;
}

/** Exact request scope: one execute request of one thread on its node. */
export function mobileSpeechRequestKey(threadKey: string, requestId: string): string {
  return `${threadKey}:${requestId}`;
}

/**
 * Single owner of speak/suppress decisions for the mobile speech pipeline.
 * Arrival rejects exact re-delivery (same speechKey) so a reconnect or
 * completion-before-ack never speaks twice. Terminals (completed/failed)
 * outrank their own turn's acks independent of arrival order via
 * threadKey+turnId plus the exact threadKey+requestId for
 * terminal-before-ack; a later legitimate turn (different turnId, even sharing
 * one originInteractionId) stays speakable on the same task. Acks without a
 * turnId fall back to scoped requestId linkage learned from arrives carrying
 * both, then to the latest ack known when a turn-less terminal arrived.
 * Among non-terminals latest-wins still retires older prompts when
 * the thread turns over.
 * Playback checkpoints consult `isStale` so a new input, cancel, or terminal
 * kills late synthesis before it becomes audible. `reset` clears thread
 * relevance on a full stop but keeps exact-duplicate memory: a re-presented
 * event must stay silent.
 */
export function createMobileSpeechGate(): {
  readonly arrive: (request: MobileSpeechRequest) => boolean;
  readonly isStale: (request: SpeechIdentity) => boolean;
  readonly reset: () => void;
} {
  const seen = new Set<string>();
  type ThreadState = {
    latestAckKey?: string;
    // The newest ack known when a turn-less terminal arrived. Only that ack
    // retires: a thread-wide flag would permanently veto every later no-turn
    // ack, and an unbounded key set would grow forever.
    retiredAckKey?: string;
  };
  const byThread = new Map<string, ThreadState>();
  const terminalTurns = new Set<string>();
  const requestTurns = new Map<string, string>();
  const terminalRequests = new Set<string>();

  const rememberSeen = (key: string): void => {
    seen.add(key);
    if (seen.size > MAX_SEEN_SPEECH_KEYS) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
  };

  const stateFor = (threadKey: string): ThreadState => {
    let state = byThread.get(threadKey);
    if (state === undefined) {
      state = {};
      byThread.set(threadKey, state);
      if (byThread.size > MAX_TRACKED_THREADS) {
        const oldest = byThread.keys().next();
        if (!oldest.done) byThread.delete(oldest.value);
      }
    }
    return state;
  };

  const rememberTerminal = (turnKey: string): void => {
    terminalTurns.add(turnKey);
    if (terminalTurns.size > MAX_TERMINAL_TURNS) {
      const oldest = terminalTurns.values().next();
      if (!oldest.done) terminalTurns.delete(oldest.value);
    }
  };

  const rememberRequestTurn = (requestKey: string, turnKey: string): void => {
    requestTurns.set(requestKey, turnKey);
    if (requestTurns.size > MAX_REQUEST_TURNS) {
      const oldest = requestTurns.keys().next();
      if (!oldest.done) requestTurns.delete(oldest.value);
    }
  };

  const rememberTerminalRequest = (requestKey: string): void => {
    terminalRequests.add(requestKey);
    if (terminalRequests.size > MAX_TERMINAL_REQUESTS) {
      const oldest = terminalRequests.values().next();
      if (!oldest.done) terminalRequests.delete(oldest.value);
    }
  };

  return {
    arrive: (request) => {
      if (seen.has(request.speechKey)) return false;
      rememberSeen(request.speechKey);
      const state = stateFor(request.threadKey);
      if (request.terminal === true) {
        if (request.turnId !== undefined) {
          rememberTerminal(mobileSpeechTurnKey(request.threadKey, request.turnId));
        }
        if (request.requestId !== undefined) {
          const requestKey = mobileSpeechRequestKey(request.threadKey, request.requestId);
          rememberTerminalRequest(requestKey);
          if (request.turnId !== undefined) {
            rememberRequestTurn(requestKey, mobileSpeechTurnKey(request.threadKey, request.turnId));
          }
        } else if (request.turnId === undefined) {
          if (state.latestAckKey !== undefined) state.retiredAckKey = state.latestAckKey;
        }
        return true;
      }
      if (request.turnId !== undefined && request.requestId !== undefined) {
        rememberRequestTurn(
          mobileSpeechRequestKey(request.threadKey, request.requestId),
          mobileSpeechTurnKey(request.threadKey, request.turnId),
        );
      }
      state.latestAckKey = request.speechKey;
      return true;
    },
    isStale: (request) => {
      if (request.terminal === true) return false;
      if (request.turnId !== undefined) {
        if (terminalTurns.has(mobileSpeechTurnKey(request.threadKey, request.turnId))) return true;
        if (
          request.requestId !== undefined &&
          terminalRequests.has(mobileSpeechRequestKey(request.threadKey, request.requestId))
        )
          return true;
      } else if (request.requestId !== undefined) {
        const requestKey = mobileSpeechRequestKey(request.threadKey, request.requestId);
        if (terminalRequests.has(requestKey)) return true;
        const linked = requestTurns.get(requestKey);
        if (linked !== undefined && terminalTurns.has(linked)) return true;
        const state = byThread.get(request.threadKey);
        if (state !== undefined && state.retiredAckKey === request.speechKey) return true;
      } else {
        const state = byThread.get(request.threadKey);
        if (state !== undefined && state.retiredAckKey === request.speechKey) return true;
      }
      const state = byThread.get(request.threadKey);
      return state?.latestAckKey !== undefined && state?.latestAckKey !== request.speechKey;
    },
    reset: () => {
      byThread.clear();
      terminalTurns.clear();
      requestTurns.clear();
      terminalRequests.clear();
    },
  };
}
