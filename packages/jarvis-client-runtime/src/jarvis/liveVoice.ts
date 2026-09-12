/**
 * Transport-agnostic reduction of a GPT-Live session. The web renderer owns
 * WebRTC; this module owns what the app does with transcript fragments,
 * delegation requests, and the bounded append commands sent back to the live
 * model. Keeping it here lets the risky half (turn text) be tested without a
 * browser, a microphone, or a network.
 *
 * OpenAI docs used here:
 * - WebRTC starts the session through POST /v1/live/sessions. The data
 *   channel must not receive a second `session.start`.
 * - Transcript deltas carry `delta` plus `start_ms`/`end_ms` on the session
 *   timeline. They are fragments, not complete turns, and delivery can be
 *   uneven. Grouping is an app choice kept revisable.
 * - `session.delegation.created` carries metadata (`delegation.id`,
 *   `delegation.target`, `offset_ms`), never task text. The client supplies
 *   context from its own transcript and app state.
 * - Appends (`session.commentary.append`, `session.thinking.append`,
 *   `session.instructions.append`) take plain-string `content` up to 500
 *   tokens and a required `delegation_id` (null for session-wide context).
 */

/**
 * Byte cap for the documented 500-token append limit. One token spans at
 * least one UTF-8 byte, so 500 bytes hold at most 500 tokens. A character
 * count cannot promise this: 1500 CJK characters are 1500 tokens or more.
 */
export const JARVIS_LIVE_VOICE_MAX_APPEND_BYTES = 500;

const appendEncoder = new TextEncoder();
const ELLIPSIS_BYTES = 3; // U+2026 in UTF-8.

/** Bounded transcript memory so a long session cannot grow strings forever. */
export const JARVIS_LIVE_VOICE_MAX_TRANSCRIPT_CHARS = 8_000;

/** Bounded fragment history for caption grouping. */
export const JARVIS_LIVE_VOICE_MAX_FRAGMENTS = 200;

/**
 * Silence between transcript fragments that starts a new utterance. The live
 * model may delegate after several spoken lines ("hello", "can you hear me",
 * "check pull requests in Rivvl"); the Director needs the request line, not
 * the small talk before it. Timing is on the session timeline, never wall
 * clock, and delivery can be uneven, so this is a grouping heuristic.
 */
export const JARVIS_LIVE_VOICE_UTTERANCE_GAP_MS = 1_200;

export interface JarvisLiveVoiceTranscriptFragment {
  readonly text: string;
  readonly startMs: number | null;
  readonly endMs: number | null;
}

export interface JarvisLiveVoiceTranscriptState {
  /** Everything the user has said in this session, in arrival order. */
  readonly userText: string;
  /** Everything the assistant has said in this session, in arrival order. */
  readonly assistantText: string;
  /** User text since the last delegation was taken. */
  readonly pendingUserText: string;
  /** Ordered user fragments with session-timeline timing. */
  readonly userFragments: ReadonlyArray<JarvisLiveVoiceTranscriptFragment>;
  /** Ordered assistant fragments with session-timeline timing. */
  readonly assistantFragments: ReadonlyArray<JarvisLiveVoiceTranscriptFragment>;
  /** User fragments added since the last delegation was taken. */
  readonly pendingUserFragments: ReadonlyArray<JarvisLiveVoiceTranscriptFragment>;
}

export function createJarvisLiveVoiceTranscript(): JarvisLiveVoiceTranscriptState {
  return {
    userText: "",
    assistantText: "",
    pendingUserText: "",
    userFragments: [],
    assistantFragments: [],
    pendingUserFragments: [],
  };
}

export type JarvisLiveVoiceServerEvent =
  | { readonly type: "session.started"; readonly sessionId: string }
  | {
      readonly type: "session.input_transcript.delta";
      readonly delta: string;
      readonly startMs: number | null;
      readonly endMs: number | null;
    }
  | {
      readonly type: "session.output_transcript.delta";
      readonly delta: string;
      readonly startMs: number | null;
      readonly endMs: number | null;
    }
  | {
      readonly type: "session.delegation.created";
      readonly delegationId: string;
      readonly target: string | null;
      readonly offsetMs: number | null;
    }
  | { readonly type: "session.closed"; readonly reason: string | null }
  | { readonly type: "session.error"; readonly message: string | null }
  | { readonly type: "other" };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asMs = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Narrow one data-channel message to the events the app acts on. Unknown
 * events (usage, appends, nested response envelopes) stay inert so a protocol
 * addition never breaks the conversation. Timing fields are preserved as
 * session-timeline metadata; they are never wall-clock time.
 */
export function parseJarvisLiveVoiceServerEvent(raw: unknown): JarvisLiveVoiceServerEvent {
  const record = asRecord(typeof raw === "string" ? safeJsonParse(raw) : raw);
  if (record === null) return { type: "other" };
  const type = asString(record.type);
  switch (type) {
    case "session.started": {
      const session = asRecord(record.session);
      const sessionId = session === null ? null : asString(session.id);
      return sessionId === null ? { type: "other" } : { type, sessionId };
    }
    case "session.input_transcript.delta":
    case "session.output_transcript.delta": {
      const delta = asString(record.delta);
      if (delta === null) return { type: "other" };
      return {
        type,
        delta,
        startMs: asMs(record.start_ms),
        endMs: asMs(record.end_ms),
      };
    }
    case "session.delegation.created": {
      const delegation = asRecord(record.delegation);
      const delegationId = delegation === null ? null : asString(delegation.id);
      if (delegationId === null) return { type: "other" };
      return {
        type,
        delegationId,
        target: delegation === null ? null : (asString(delegation.target) ?? null),
        offsetMs: asMs(record.offset_ms),
      };
    }
    case "session.closed":
      return { type, reason: asString(record.reason) };
    case "error": {
      const error = asRecord(record.error);
      return { type: "session.error", message: error === null ? null : asString(error.message) };
    }
    default:
      return { type: "other" };
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const boundTail = (value: string): string =>
  value.length > JARVIS_LIVE_VOICE_MAX_TRANSCRIPT_CHARS
    ? value.slice(-JARVIS_LIVE_VOICE_MAX_TRANSCRIPT_CHARS)
    : value;

const boundFragments = (
  fragments: ReadonlyArray<JarvisLiveVoiceTranscriptFragment>,
): ReadonlyArray<JarvisLiveVoiceTranscriptFragment> =>
  fragments.length > JARVIS_LIVE_VOICE_MAX_FRAGMENTS
    ? fragments.slice(-JARVIS_LIVE_VOICE_MAX_FRAGMENTS)
    : fragments;

export function applyJarvisLiveVoiceTranscript(
  state: JarvisLiveVoiceTranscriptState,
  event: JarvisLiveVoiceServerEvent,
): JarvisLiveVoiceTranscriptState {
  switch (event.type) {
    case "session.input_transcript.delta": {
      if (event.delta.length === 0) return state;
      const fragment = { text: event.delta, startMs: event.startMs, endMs: event.endMs };
      return {
        ...state,
        userText: boundTail(state.userText + event.delta),
        pendingUserText: boundTail(state.pendingUserText + event.delta),
        userFragments: boundFragments([...state.userFragments, fragment]),
        pendingUserFragments: boundFragments([...state.pendingUserFragments, fragment]),
      };
    }
    case "session.output_transcript.delta": {
      if (event.delta.length === 0) return state;
      return {
        ...state,
        assistantText: boundTail(state.assistantText + event.delta),
        assistantFragments: boundFragments([
          ...state.assistantFragments,
          { text: event.delta, startMs: event.startMs, endMs: event.endMs },
        ]),
      };
    }
    default:
      return state;
  }
}

/** Last sentence of a run with no usable timing; commas never split. */
function lastSentence(text: string): string {
  const trimmed = text.trim();
  const matches = [...trimmed.matchAll(/[.!?]+/gu)];
  const last = matches[matches.length - 1];
  if (last === undefined || last.index === undefined) return trimmed;
  const end = last.index + last[0].length;
  const tail = trimmed.slice(end).trim();
  if (tail.length > 0) return tail;
  if (matches.length === 1) return trimmed;
  const previous = matches[matches.length - 2];
  if (previous === undefined || previous.index === undefined) return trimmed;
  return trimmed.slice(previous.index + previous[0].length).trim();
}

interface TimedUtteranceGroup {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Group user fragments into utterances by silence, or null when any fragment
 * lacks usable timing. Null keeps the caller on the no-timing fallback.
 */
function timedUtteranceGroups(
  fragments: ReadonlyArray<JarvisLiveVoiceTranscriptFragment>,
): TimedUtteranceGroup[] | null {
  if (!fragments.every((fragment) => fragment.startMs !== null && fragment.endMs !== null)) {
    return null;
  }
  const groups: TimedUtteranceGroup[] = [];
  let current: JarvisLiveVoiceTranscriptFragment[] = [];
  const flush = (endMs: number): void => {
    const first = current[0];
    const text = current
      .map((fragment) => fragment.text)
      .join("")
      .trim();
    if (first !== undefined && first.startMs !== null && text.length > 0) {
      groups.push({ text, startMs: first.startMs, endMs });
    }
    current = [];
  };
  for (const fragment of fragments) {
    const previous = current[current.length - 1];
    if (
      previous !== undefined &&
      previous.endMs !== null &&
      fragment.startMs !== null &&
      fragment.startMs - previous.endMs > JARVIS_LIVE_VOICE_UTTERANCE_GAP_MS
    ) {
      flush(previous.endMs);
    }
    current.push(fragment);
  }
  const last = current[current.length - 1];
  if (last !== undefined && last.endMs !== null) flush(last.endMs);
  return groups;
}

/**
 * The utterance for one backend delegation. The event carries no task text,
 * so the client supplies the user's speech since the previous delegation.
 * Speech is grouped into utterances by silence on the session timeline and
 * the last utterance is delegated: "hello" / "can you hear me" / "check pull
 * requests in Rivvl" must send the request, not the greeting.
 *
 * When the assistant asked a question between the previous user utterance and
 * a short answer, the delegated text carries the earlier utterance too, so
 * "what's the weather" + "gujarat" reaches the backend as one request instead
 * of a bare city. A delegation that arrives before its transcript delta is
 * held by the caller and retried, so this function only reports what it sees.
 *
 * Without usable timing, the last sentence is taken when the run contains
 * sentence punctuation. Empty pending speech means no new request: the caller
 * skips instead of replaying the session transcript.
 */
export function takeJarvisLiveVoiceDelegateUtterance(state: JarvisLiveVoiceTranscriptState): {
  readonly utterance: string;
  readonly state: JarvisLiveVoiceTranscriptState;
} {
  const cleared: JarvisLiveVoiceTranscriptState = {
    ...state,
    pendingUserText: "",
    pendingUserFragments: [],
  };
  const pending = state.pendingUserFragments;
  if (pending.length === 0) return { utterance: "", state: cleared };

  const groups = timedUtteranceGroups(pending);
  if (groups === null) {
    const joined = pending
      .map((fragment) => fragment.text)
      .join("")
      .trim();
    return { utterance: lastSentence(joined), state: cleared };
  }
  const candidate = groups[groups.length - 1];
  if (candidate === undefined || candidate.text.length === 0) {
    return { utterance: "", state: cleared };
  }

  let utterance = candidate.text;
  const sessionGroups = timedUtteranceGroups(state.userFragments);
  if (sessionGroups !== null && sessionGroups.length >= 2) {
    const lastSessionGroup = sessionGroups[sessionGroups.length - 1]!;
    const previousSessionGroup = sessionGroups[sessionGroups.length - 2]!;
    if (lastSessionGroup.text === candidate.text) {
      const answeredQuestion = state.assistantFragments.some(
        (fragment) =>
          fragment.startMs !== null &&
          fragment.endMs !== null &&
          fragment.startMs >= previousSessionGroup.endMs &&
          fragment.endMs <= candidate.startMs &&
          fragment.text.includes("?"),
      );
      const words = candidate.text.split(/\s+/u).filter((word) => word.length > 0);
      if (answeredQuestion && words.length <= 4) {
        utterance = `${previousSessionGroup.text} ${candidate.text}`.trim();
      }
    }
  }
  return { utterance, state: cleared };
}

/**
 * The most recent user utterance, without consuming it. The live model can
 * refuse ("I don't have live weather access") instead of delegating; the
 * controller then hands this text to the backend so the request still runs.
 */
export function lastJarvisLiveVoiceUtterance(state: JarvisLiveVoiceTranscriptState): string {
  const groups = timedUtteranceGroups(state.userFragments);
  if (groups !== null && groups.length > 0) {
    return groups[groups.length - 1]?.text ?? "";
  }
  const joined = state.userFragments
    .map((fragment) => fragment.text)
    .join("")
    .trim();
  return joined.length === 0 ? "" : lastSentence(joined);
}

/**
 * Bound and normalize text for append commands. The live model paraphrases
 * appended commentary, so no speech formatting belongs here. Truncation walks
 * code points and cuts only on character boundaries, so multi-byte text never
 * splits a surrogate pair or a UTF-8 sequence.
 */
export function jarvisLiveVoiceAppendText(
  text: string,
  maxBytes = JARVIS_LIVE_VOICE_MAX_APPEND_BYTES,
): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (appendEncoder.encode(normalized).length <= maxBytes) return normalized;
  if (maxBytes <= ELLIPSIS_BYTES) return "";
  let bytes = 0;
  let end = 0;
  for (const unit of normalized) {
    const width = appendEncoder.encode(unit).length;
    if (bytes + width > maxBytes - ELLIPSIS_BYTES) break;
    bytes += width;
    end += unit.length;
  }
  return `${normalized.slice(0, end).trimEnd()}\u2026`;
}

export interface JarvisLiveVoiceAppendCommand {
  readonly type: "session.commentary.append" | "session.thinking.append";
  readonly event_id: string;
  readonly delegation_id: string | null;
  readonly content: string;
}

/**
 * Commentary is for results the model should say aloud; thinking is quiet
 * progress context. Both require a delegation id or an explicit null. A
 * non-null id must name a known client delegation.
 */
export function jarvisLiveVoiceAppendCommand(
  kind: "commentary" | "thinking",
  content: string,
  options: { readonly delegationId?: string | null; readonly eventId: string },
): JarvisLiveVoiceAppendCommand | null {
  const bounded = jarvisLiveVoiceAppendText(content);
  if (bounded.length === 0) return null;
  return {
    type: kind === "commentary" ? "session.commentary.append" : "session.thinking.append",
    event_id: options.eventId,
    delegation_id: options.delegationId ?? null,
    content: bounded,
  };
}
