import {
  applyCirceLiveVoiceTranscript,
  createCirceLiveVoiceTranscript,
  circeLiveVoiceAppendCommand,
  lastCirceLiveVoiceUtterance,
  parseCirceLiveVoiceServerEvent,
  takeCirceLiveVoiceDelegateUtterance,
  type CirceLiveVoiceTranscriptState,
} from "@circe/client-runtime/circe/liveVoice";

import { CIRCE_LIVE_VOICE_MAX_CONTEXT_LENGTH } from "@t3tools/contracts";
/**
 * Clear refusals that mean "I cannot do this without backend tools". When one
 * arrives without a client delegation, the controller forwards the user's
 * last utterance to the backend so the request still runs.
 */
const CIRCE_LIVE_VOICE_TOOL_REFUSAL =
  /(?:i (?:don'?t|do not|can'?t|cannot|am not able to|do not have|don'?t have)|as an ai)[^.\n]{0,80}(?:access|fetch|retrieve|check|get|provide|real-?time|live|weather|current)/iu;

import { randomUUID } from "../../lib/utils";

export type CirceLiveVoiceStatus =
  | "idle"
  | "requesting"
  | "connecting"
  | "live"
  | "closing"
  | "failed";

/** Honest terminal reason so the UI can stop billing without guessing. */
export type CirceLiveVoiceCloseReason = "user" | "idle" | "max-duration" | "remote" | "error";

/**
 * Deterministic startup milestones. Recording only: stages never start billed
 * work early and never send on the data channel. `session.started` still
 * gates every application command.
 */
export type CirceLiveVoiceStartupStage =
  | "mic-requested"
  | "media-ready"
  | "offer-ready"
  | "session-connecting";

/** 60s without user speech ends the billed session. Initial grace included. */
/**
 * A delegation can arrive before the transcript delta for the words it
 * answers. The controller holds the delegation open this long and retries
 * when the next input fragment lands.
 */
export const CIRCE_LIVE_VOICE_DELEGATION_RETRY_MS = 2_500;

export const CIRCE_LIVE_VOICE_DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** 10 minutes hard cap on one billed session. */
export const CIRCE_LIVE_VOICE_DEFAULT_MAX_SESSION_MS = 10 * 60_000;
/**
 * How often the renderer renews its server-side lease. Three missed beats close
 * the session on the node, so a killed or sleeping renderer cannot leave it
 * billing on client timers alone.
 */
export const CIRCE_LIVE_VOICE_DEFAULT_RENEW_INTERVAL_MS = 20_000;
/** Bounded startup so a stuck mic, ICE, or RPC cannot hang the button. */
export const CIRCE_LIVE_VOICE_DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

export interface CirceLiveVoiceStartResult {
  readonly releaseRequired?: boolean;
  readonly sessionId: string;
  readonly sdpAnswer: string;
  readonly model: string;
  readonly voice: string;
}

export interface CirceLiveVoiceMediaTrack {
  stop(): void;
}

export interface CirceLiveVoiceMediaStream {
  getAudioTracks(): ReadonlyArray<CirceLiveVoiceMediaTrack>;
}

export interface CirceLiveVoiceAudioElement {
  autoplay: boolean;
  srcObject: unknown;
  play(): Promise<void>;
}

export interface CirceLiveVoiceDataChannel {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  readonly readyState: string;
  send(data: string): void;
  close(): void;
}

export interface CirceLiveVoicePeerConnection {
  ontrack:
    | ((event: { readonly track: unknown; readonly streams?: ReadonlyArray<unknown> }) => void)
    | null;
  readonly localDescription: { readonly sdp?: string } | null;
  readonly iceGatheringState: string;
  addEventListener(type: "icegatheringstatechange", listener: () => void): void;
  removeEventListener(type: "icegatheringstatechange", listener: () => void): void;
  addTrack(track: unknown, stream: CirceLiveVoiceMediaStream): void;
  createDataChannel(label: string): CirceLiveVoiceDataChannel;
  createOffer(): Promise<{ readonly sdp?: string }>;
  setLocalDescription(description: { readonly type: "offer"; readonly sdp: string }): Promise<void>;
  setRemoteDescription(description: {
    readonly type: "answer";
    readonly sdp: string;
  }): Promise<void>;
  close(): void;
}

/** Injectable browser surface so the session loop runs under tests without WebRTC. */
export interface CirceLiveVoiceBrowser {
  createPeerConnection(): CirceLiveVoicePeerConnection;
  createAudioElement(): CirceLiveVoiceAudioElement;
  createMediaStream(track: unknown): CirceLiveVoiceMediaStream;
  getUserMedia(): Promise<CirceLiveVoiceMediaStream>;
  createSilentStream(): CirceLiveVoiceMediaStream;
  createId(): string;
}

export interface CirceLiveVoiceControllerOptions {
  readonly release?: (sessionId: string) => Promise<void>;
  /**
   * Renew the server-side lease on the active session. The node closes a
   * session whose lease lapses, so this is what keeps it alive and lets the
   * server end it after a killed or sleeping renderer.
   */
  readonly renew?: (sessionId: string) => Promise<void>;
  readonly renewIntervalMs?: number;
  readonly start: (input: {
    readonly sdpOffer: string;
    readonly context?: string;
  }) => Promise<CirceLiveVoiceStartResult>;
  /** Hand one delegated utterance to the Circe Director. Returns false when no runtime accepted it. */
  readonly delegate: (utterance: string, delegationId: string) => boolean;
  readonly onStatus?: (status: CirceLiveVoiceStatus) => void;
  readonly onTranscript?: (state: CirceLiveVoiceTranscriptState) => void;
  /** Combined mic/output amplitude 0..1 for the orb; optional. */
  readonly onAudioLevel?: (level: number) => void;
  readonly onFailure?: (message: string) => void;
  /** Terminal reason. Optional so existing callers keep working. */
  readonly onClosed?: (reason: CirceLiveVoiceCloseReason) => void;
  /** Startup milestone recorder. Optional; never drives behavior. */
  readonly onStage?: (stage: CirceLiveVoiceStartupStage, atMs: number) => void;
  /** Bounded app state snapshot for the live model. Built from the live catalog at start. */
  readonly context?: () => string | undefined;
  readonly browser?: CirceLiveVoiceBrowser;
  readonly iceGatheringTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  /**
   * Announcement sessions do not listen: they use a generated silent track
   * and mute model input so a report can be spoken with no microphone
   * permission prompt. User conversations default to true.
   */
  readonly listen?: boolean;
  /** No user speech for this long ends the session. 0 disables. Default 60s. */
  readonly idleTimeoutMs?: number;
  /** Hard cap on one session. 0 disables. Default 10 minutes. */
  readonly maxSessionMs?: number;
  /** Startup must reach live within this long. Default 30s. */
  readonly startupTimeoutMs?: number;
  readonly now?: () => number;
}

export interface CirceLiveVoiceController {
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
  /** Append a result the live model should say aloud. */
  readonly speak: (text: string) => void;
  /** Append quiet progress context the model can use without speaking it. */
  readonly note: (text: string) => void;
  readonly getStatus: () => CirceLiveVoiceStatus;
  readonly getTranscript: () => CirceLiveVoiceTranscriptState;
}

const defaultBrowser: CirceLiveVoiceBrowser = {
  createPeerConnection: () => new RTCPeerConnection() as unknown as CirceLiveVoicePeerConnection,
  createAudioElement: () => new Audio() as unknown as CirceLiveVoiceAudioElement,
  createMediaStream: (track) =>
    new MediaStream([track as MediaStreamTrack]) as unknown as CirceLiveVoiceMediaStream,
  getUserMedia: async () =>
    (await navigator.mediaDevices.getUserMedia({
      audio: true,
    })) as unknown as CirceLiveVoiceMediaStream,
  createSilentStream: () => {
    // A generated zero-gain track keeps the session valid without opening the
    // microphone. If WebAudio is unavailable, an empty stream is still a
    // trackless but honest fallback.
    try {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const gain = context.createGain();
      gain.gain.value = 0;
      const source = context.createOscillator();
      source.frequency.value = 440;
      source.connect(gain);
      gain.connect(destination);
      source.start();
      return destination.stream as unknown as CirceLiveVoiceMediaStream;
    } catch {
      return new MediaStream() as unknown as CirceLiveVoiceMediaStream;
    }
  },
  createId: () => randomUUID(),
};

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "Live voice could not start.";
};

type TimeoutHandle = ReturnType<typeof setTimeout>;

/**
 * One full-duplex GPT-Live conversation. The live model owns speech; every
 * project or task decision is delegated back into the ordinary Circe
 * submission queue, and appended commentary is how the backend result reaches
 * the user's ear.
 *
 * Lifecycle notes (OpenAI documented behavior preserved):
 * - The HTTP session creation starts billing. No `session.start` is sent on
 *   the data channel. Media travels on negotiated tracks.
 * - `session.started` gates application commands: earlier commentary and thinking
 *   appends wait in the bounded queue. `session.close` then
 *   `session.closed` finalizes usage. A socket close alone proves nothing.
 * - Never auto-reconnects: a fresh billed session needs an explicit start.
 * - Delegation is client-mode only. Duplicate ids and empty pending text are
 *   skipped without replaying the session transcript.
 *
 * Cap timers are best-effort. A backgrounded renderer can have its timeouts
 * clamped, and a suspended or killed page runs no timers at all, so the idle
 * and max-duration closes below cannot promise provider-side hangup. They
 * bound billing while this client runs. Cloud sessions release through the node
 * so the relay can confirm hangup and free the account reservation.
 */
/**
 * Peak amplitude across the local mic and the model's audio, for the orb.
 * One shared AudioContext; best-effort, never throws into the session.
 */
interface CirceAudioLevelMeter {
  attach(stream: CirceLiveVoiceMediaStream): void;
  read(): number;
  close(): void;
}

function createCirceAudioLevelMeter(): CirceAudioLevelMeter | null {
  const Ctor =
    typeof globalThis.AudioContext !== "undefined"
      ? globalThis.AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return null;
  const context = new Ctor();
  const analysers: Array<{ readonly node: AnalyserNode; readonly data: Uint8Array<ArrayBuffer> }> =
    [];
  return {
    attach(stream) {
      try {
        const source = context.createMediaStreamSource(stream as unknown as MediaStream);
        const node = context.createAnalyser();
        node.fftSize = 256;
        source.connect(node);
        analysers.push({ node, data: new Uint8Array(new ArrayBuffer(node.fftSize)) });
      } catch {
        // Analyser attach is best effort.
      }
    },
    read() {
      let peak = 0;
      for (const { node, data } of analysers) {
        node.getByteTimeDomainData(data);
        let sum = 0;
        for (const byte of data) {
          const centered = (byte - 128) / 128;
          sum += centered * centered;
        }
        peak = Math.max(peak, Math.sqrt(sum / data.length));
      }
      return Math.min(1, peak * 3);
    },
    close() {
      void context.close().catch(() => undefined);
    },
  };
}

export function createCirceLiveVoiceController(
  options: CirceLiveVoiceControllerOptions,
): CirceLiveVoiceController {
  const browser = options.browser ?? defaultBrowser;
  const listen = options.listen ?? true;
  const idleTimeoutMs = options.idleTimeoutMs ?? CIRCE_LIVE_VOICE_DEFAULT_IDLE_TIMEOUT_MS;
  const maxSessionMs = options.maxSessionMs ?? CIRCE_LIVE_VOICE_DEFAULT_MAX_SESSION_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? CIRCE_LIVE_VOICE_DEFAULT_STARTUP_TIMEOUT_MS;
  const renewIntervalMs = options.renewIntervalMs ?? CIRCE_LIVE_VOICE_DEFAULT_RENEW_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let status: CirceLiveVoiceStatus = "idle";
  let transcript = createCirceLiveVoiceTranscript();
  let peer: CirceLiveVoicePeerConnection | null = null;
  let channel: CirceLiveVoiceDataChannel | null = null;
  let audio: CirceLiveVoiceAudioElement | null = null;
  let stream: CirceLiveVoiceMediaStream | null = null;
  let levelMeter: CirceAudioLevelMeter | null = null;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  const stopLevelMeter = () => {
    if (levelTimer !== null) {
      clearInterval(levelTimer);
      levelTimer = null;
    }
    levelMeter?.close();
    levelMeter = null;
  };
  let delegationId: string | null = null;
  const seenDelegationIds = new Set<string>();
  let resolveClosed: (() => void) | null = null;
  let pendingCloseReason: CirceLiveVoiceCloseReason | null = null;
  let closePromise: Promise<void> | null = null;
  let cloudSessionId: string | null = null;
  let releasePending: Promise<void> = Promise.resolve();
  let sessionCreation: Promise<CirceLiveVoiceStartResult> | null = null;
  const releaseSession = (sessionId: string) => {
    const pending = Promise.resolve()
      .then(() => {
        if (!options.release)
          throw new Error("This client cannot release cloud live voice. Update Circe and retry.");
        return options.release(sessionId);
      })
      .catch((error: unknown) => {
        options.onFailure?.(errorMessage(error));
      });
    releasePending = Promise.all([releasePending, pending]).then(() => undefined);
    return pending;
  };
  const releaseCloudSession = () => {
    const sessionId = cloudSessionId;
    cloudSessionId = null;
    if (sessionId !== null) void releaseSession(sessionId);
  };
  // Bumps on every start/close/fail so late mic, offer, ICE, or RPC
  // continuations cannot flip a torn-down session back to live. Every waiter
  // removes its own listener on settle, so a finished startup leaves none.
  let generation = 0;
  const cancelListeners = new Set<() => void>();
  const bumpGeneration = () => {
    generation += 1;
    for (const listener of [...cancelListeners]) {
      try {
        listener();
      } catch {
        // Listener failure must not break teardown.
      }
    }
  };
  const cancellable = async <T>(promise: Promise<T>, gen: number): Promise<T | null> => {
    if (gen !== generation) return null;
    let onCancel: (() => void) | null = null;
    const cancel = new Promise<null>((resolve) => {
      onCancel = () => resolve(null);
      cancelListeners.add(onCancel);
    });
    try {
      const result = await Promise.race([
        promise.then((value) => ({ value })),
        cancel.then(() => null),
      ]);
      if (result === null || gen !== generation) return null;
      return result.value;
    } finally {
      if (onCancel !== null) cancelListeners.delete(onCancel);
    }
  };
  let startupTimer: TimeoutHandle | null = null;
  let idleTimer: TimeoutHandle | null = null;
  let maxTimer: TimeoutHandle | null = null;
  let closeTimer: TimeoutHandle | null = null;
  let deferralTimer: TimeoutHandle | null = null;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let liveSessionId: string | null = null;
  let deferredDelegationId: string | null = null;
  let lastUserSpeechAt = 0;
  // Speak a short cue the moment the line is live, so the user knows when
  // Circe can hear them instead of talking into a connecting session.
  let greetedSession = false;
  // The model can end its turn with a refusal instead of delegating. One
  // auto-delegation per user turn keeps the request alive without replaying.
  let delegationHandledSinceUserSpeech = false;
  // A delegated request is still outstanding at the backend. The session must
  // not idle-close while it waits, or the spoken result is cut off.
  let awaitingDelegation = false;
  let autoDelegationSeq = 0;

  const setStatus = (next: CirceLiveVoiceStatus) => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  const emitStage = (stage: CirceLiveVoiceStartupStage) => {
    try {
      options.onStage?.(stage, now());
    } catch {
      // Stage recording must not break startup.
    }
  };

  const clearTimer = (handle: TimeoutHandle | null): null => {
    if (handle !== null) clearTimeout(handle);
    return null;
  };

  const clearStartupTimer = () => {
    startupTimer = clearTimer(startupTimer);
  };
  const clearIdleTimer = () => {
    idleTimer = clearTimer(idleTimer);
  };
  const clearMaxTimer = () => {
    maxTimer = clearTimer(maxTimer);
  };
  const clearCloseTimer = () => {
    closeTimer = clearTimer(closeTimer);
  };
  const clearDeferral = () => {
    deferralTimer = clearTimer(deferralTimer);
    deferredDelegationId = null;
  };
  const clearRenewTimer = () => {
    if (renewTimer !== null) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  };
  const clearSessionTimers = () => {
    clearStartupTimer();
    clearIdleTimer();
    clearMaxTimer();
    clearCloseTimer();
    clearDeferral();
    clearRenewTimer();
  };

  // Reads through the mutable closure so an event received during an await
  // (for example a failed connection) is visible to the close path.
  const readStatus = (): CirceLiveVoiceStatus => status;

  const stopMicrophone = () => {
    if (stream === null) return;
    const current = stream;
    stream = null;
    for (const track of current.getAudioTracks()) {
      try {
        track.stop();
      } catch {
        // Stopping an ended track is not actionable.
      }
    }
  };

  const teardown = () => {
    releaseCloudSession();
    clearSessionTimers();
    liveSessionId = null;
    stopLevelMeter();
    awaitingDelegation = false;
    const pendingResolve = resolveClosed;
    resolveClosed = null;
    pendingCloseReason = null;
    const currentChannel = channel;
    channel = null;
    if (currentChannel !== null) {
      currentChannel.onmessage = null;
      currentChannel.onclose = null;
      currentChannel.onerror = null;
      try {
        currentChannel.close();
      } catch {
        // Closing an already-closed channel is not actionable.
      }
    }
    stopMicrophone();
    if (peer !== null) {
      try {
        peer.close();
      } catch {
        // Closing an already-closed connection is not actionable.
      }
      peer = null;
    }
    if (audio !== null) {
      audio.srcObject = null;
      audio = null;
    }
    delegationId = null;
    if (pendingResolve !== null) pendingResolve();
  };

  const notifyClosed = (reason: CirceLiveVoiceCloseReason) => {
    try {
      options.onClosed?.(reason);
    } catch {
      // Reporting must not break teardown.
    }
  };

  const send = (payload: unknown) => {
    if (channel === null || channel.readyState !== "open") return false;
    try {
      channel.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const append = (kind: "commentary" | "thinking", text: string) => {
    const command = circeLiveVoiceAppendCommand(kind, text, {
      delegationId,
      eventId: browser.createId(),
    });
    if (command !== null) send(command);
  };

  /**
   * Appends before `session.started` queue instead of dropping: an
   * announcement starts a session and hands it text while it connects.
   * Bounded so a burst cannot grow the queue without limit.
   */
  const pendingAppends: Array<{ readonly kind: "commentary" | "thinking"; readonly text: string }> =
    [];
  const queueAppend = (kind: "commentary" | "thinking", text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (readStatus() === "live") {
      append(kind, trimmed);
      return;
    }
    pendingAppends.push({ kind, text: trimmed });
    if (pendingAppends.length > 8) pendingAppends.shift();
  };
  const flushPendingAppends = () => {
    const queued = pendingAppends.splice(0);
    for (const entry of queued) append(entry.kind, entry.text);
  };

  const fail = (message: string) => {
    bumpGeneration();
    teardown();
    setStatus("failed");
    options.onFailure?.(message);
    notifyClosed("error");
  };

  const scheduleIdle = () => {
    clearIdleTimer();
    if (idleTimeoutMs <= 0 || status !== "live") return;
    const gen = generation;
    idleTimer = setTimeout(() => {
      if (gen !== generation || readStatus() !== "live") return;
      if (awaitingDelegation) {
        scheduleIdle();
        return;
      }
      if (now() - lastUserSpeechAt < idleTimeoutMs) return;
      void closeInternal("idle");
    }, idleTimeoutMs);
  };

  const scheduleMax = () => {
    clearMaxTimer();
    if (maxSessionMs <= 0) return;
    const gen = generation;
    maxTimer = setTimeout(() => {
      if (gen !== generation) return;
      const current = readStatus();
      if (current === "idle" || current === "failed") return;
      void closeInternal("max-duration");
    }, maxSessionMs);
  };

  const scheduleStartup = (gen: number) => {
    clearStartupTimer();
    if (startupTimeoutMs <= 0) return;
    startupTimer = setTimeout(() => {
      if (gen !== generation) return;
      if (readStatus() !== "requesting" && readStatus() !== "connecting") return;
      fail("Live voice startup timed out.");
    }, startupTimeoutMs);
  };

  // Keeps the node's lease fresh while the session is live. If this renderer is
  // killed or suspended, the renewals stop and the node closes the session on
  // its own timer instead of leaving it billing.
  const scheduleRenew = () => {
    clearRenewTimer();
    const renew = options.renew;
    if (renew === undefined || renewIntervalMs <= 0) return;
    const gen = generation;
    renewTimer = setInterval(() => {
      const sessionId = liveSessionId;
      if (gen !== generation || sessionId === null || readStatus() !== "live") return;
      void renew(sessionId).catch(() => undefined);
    }, renewIntervalMs);
  };

  const waitForIceGathering = (
    nextPeer: CirceLiveVoicePeerConnection,
    timeoutMs: number,
    gen: number,
  ): Promise<boolean> => {
    if (nextPeer.iceGatheringState === "complete") return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const onCancel = () => finish(false);
      const finish = (complete: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        nextPeer.removeEventListener("icegatheringstatechange", onState);
        cancelListeners.delete(onCancel);
        resolve(complete && gen === generation);
      };
      const onState = () => {
        if (nextPeer.iceGatheringState === "complete") finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      cancelListeners.add(onCancel);
      nextPeer.addEventListener("icegatheringstatechange", onState);
      onState();
    });
  };

  const closeInternal = async (reason: CirceLiveVoiceCloseReason): Promise<void> => {
    if (readStatus() === "idle" || readStatus() === "failed") {
      teardown();
      if (readStatus() !== "failed") setStatus("idle");
      await sessionCreation?.catch(() => undefined);
      await releasePending;
      return;
    }
    if (readStatus() === "closing") return closePromise ?? Promise.resolve();
    // Cancel in-flight startup work. The graceful exchange below uses captured
    // references so it is not cancelled by its own bump.
    bumpGeneration();
    const gracefulPeer = peer;
    const gracefulChannel = channel;
    setStatus("closing");
    pendingCloseReason = reason;
    clearStartupTimer();
    clearIdleTimer();
    clearMaxTimer();
    // Stop billing input locally right away instead of after the round trip.
    // Delegated Director work already accepted keeps running on the node.
    stopMicrophone();
    if (cloudSessionId !== null) {
      releaseCloudSession();
      await releasePending;
    } else if (gracefulChannel !== null && gracefulChannel.readyState === "open") {
      // Local-key sessions always close over the data channel, including when
      // creation is still in flight: a late local answer is suppressed above,
      // and cloud sessions are already covered by the node release, so this
      // branch can never double-close a cloud session.
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      send({ type: "session.close" });
      const bounded = new Promise<void>((resolve) => {
        clearCloseTimer();
        closeTimer = setTimeout(resolve, options.closeTimeoutMs ?? 15_000);
      });
      const waiter = (async () => {
        await Promise.race([closed, bounded]);
      })();
      closePromise = waiter.then(() => {
        closePromise = null;
      });
      await waiter;
      clearCloseTimer();
      if (readStatus() === "idle" || readStatus() === "failed") {
        closePromise = null;
        return;
      }
    }
    const finishedReason = pendingCloseReason ?? reason;
    // Use captured refs only to avoid racing a newer session. teardown()
    // clears the current fields, which are these refs when no new start ran
    // (start is blocked while closing).
    void gracefulPeer;
    void gracefulChannel;
    teardown();
    if (readStatus() !== "failed") setStatus("idle");
    await sessionCreation?.catch(() => undefined);
    await releasePending;
    notifyClosed(finishedReason);
  };

  const handleEvent = (raw: string) => {
    const event = parseCirceLiveVoiceServerEvent(raw);
    switch (event.type) {
      case "session.started": {
        if (readStatus() === "closing" || readStatus() === "idle" || readStatus() === "failed") {
          break;
        }
        clearStartupTimer();
        lastUserSpeechAt = now();
        setStatus("live");
        if (!listen) {
          // Announcement sessions never listen, even if a track exists.
          send({ type: "session.input_audio.mute", event_id: browser.createId() });
        }
        flushPendingAppends();
        if (listen && !greetedSession) {
          greetedSession = true;
          // A short spoken cue confirms the line is live; without it the
          // user can speak into a still-connecting session and be dropped.
          append("commentary", "Hey, Circe here. Go ahead.");
        }
        scheduleIdle();
        scheduleRenew();
        break;
      }
      case "session.input_transcript.delta":
      case "session.output_transcript.delta": {
        if (readStatus() !== "live") break;
        transcript = applyCirceLiveVoiceTranscript(transcript, event);
        options.onTranscript?.(transcript);
        if (event.type === "session.input_transcript.delta" && event.delta.length > 0) {
          lastUserSpeechAt = now();
          delegationHandledSinceUserSpeech = false;
          scheduleIdle();
          // A held delegation retries the moment its transcript arrives, so a
          // short answer like "gujarat" is submitted instead of dropped.
          if (deferredDelegationId !== null) {
            const retryId = deferredDelegationId;
            const retry = takeCirceLiveVoiceDelegateUtterance(transcript);
            transcript = retry.state;
            options.onTranscript?.(transcript);
            if (retry.utterance.length > 0) {
              clearDeferral();
              delegationHandledSinceUserSpeech = true;
              awaitingDelegation = true;
              if (!options.delegate(retry.utterance, retryId)) {
                append("commentary", "I could not submit that request on this device.");
              }
            }
          }
        }
        if (event.type === "session.output_transcript.delta" && event.delta.length > 0) {
          awaitingDelegation = false;
          scheduleIdle();
        }
        if (
          event.type === "session.output_transcript.delta" &&
          event.delta.length > 0 &&
          !delegationHandledSinceUserSpeech &&
          CIRCE_LIVE_VOICE_TOOL_REFUSAL.test(transcript.assistantText.slice(-400))
        ) {
          const utterance = lastCirceLiveVoiceUtterance(transcript);
          if (utterance.length > 0) {
            delegationHandledSinceUserSpeech = true;
            awaitingDelegation = true;
            autoDelegationSeq += 1;
            const autoId = `circe-live-auto-${autoDelegationSeq}`;
            if (!options.delegate(utterance, autoId)) {
              append("commentary", "I could not submit that request on this device.");
            }
          }
        }
        break;
      }
      case "session.delegation.created": {
        if (readStatus() !== "live") break;
        // Responses-mode delegations are not ours; this session runs client
        // delegation. Skipping them avoids duplicate backend work.
        if (event.target !== null && event.target !== "client") break;
        if (seenDelegationIds.has(event.delegationId)) break;
        seenDelegationIds.add(event.delegationId);
        delegationId = event.delegationId;
        const taken = takeCirceLiveVoiceDelegateUtterance(transcript);
        transcript = taken.state;
        options.onTranscript?.(transcript);
        if (taken.utterance.length === 0) {
          // The event can land before the transcript delta for the words it
          // answers. Hold it and retry on the next input fragment; only after
          // the window does this mean there is genuinely nothing to submit.
          clearDeferral();
          deferredDelegationId = event.delegationId;
          deferralTimer = setTimeout(() => {
            deferralTimer = null;
            deferredDelegationId = null;
          }, CIRCE_LIVE_VOICE_DELEGATION_RETRY_MS);
          break;
        }
        clearDeferral();
        delegationHandledSinceUserSpeech = true;
        awaitingDelegation = true;
        if (!options.delegate(taken.utterance, event.delegationId)) {
          append("commentary", "I could not submit that request on this device.");
        }
        break;
      }
      case "session.closed": {
        const terminalReason: CirceLiveVoiceCloseReason =
          event.reason === "expired"
            ? "max-duration"
            : (pendingCloseReason ?? (resolveClosed === null ? "remote" : "user"));
        resolveClosed?.();
        resolveClosed = null;
        clearCloseTimer();
        teardown();
        if (readStatus() !== "failed") setStatus("idle");
        notifyClosed(terminalReason);
        break;
      }
      case "session.error":
        options.onFailure?.(event.message ?? "Live voice reported an error.");
        break;
      case "other":
        break;
    }
  };

  const start = async (): Promise<void> => {
    if (status !== "idle" && status !== "failed") return;
    if (status === "failed") teardown();
    transcript = createCirceLiveVoiceTranscript();
    seenDelegationIds.clear();
    delegationId = null;
    closePromise = null;
    pendingCloseReason = null;
    const gen = (bumpGeneration(), generation);
    lastUserSpeechAt = now();
    setStatus("requesting");
    scheduleMax();
    scheduleStartup(gen);
    let nextPeer: CirceLiveVoicePeerConnection | null = null;
    try {
      nextPeer = browser.createPeerConnection();
      if (gen !== generation) {
        try {
          nextPeer.close();
        } catch {
          // Already torn down.
        }
        return;
      }
      peer = nextPeer;
      // Kick off the slow local step first. Everything below until the offer
      // is synchronous setup that overlaps the permission prompt instead of
      // waiting behind it. Nothing here touches the network or bills.
      // Announcement sessions use a generated silent track: no microphone,
      // no permission prompt.
      const micPromise = listen
        ? browser.getUserMedia()
        : Promise.resolve(browser.createSilentStream());
      const element = browser.createAudioElement();
      element.autoplay = true;
      audio = element;
      if (options.onAudioLevel !== undefined) {
        levelMeter = createCirceAudioLevelMeter();
        if (levelMeter !== null) {
          const meter = levelMeter;
          levelTimer = setInterval(() => options.onAudioLevel?.(meter.read()), 70);
        }
      }
      const data = nextPeer.createDataChannel("oai-events");
      if (gen !== generation || peer !== nextPeer) {
        try {
          data.close();
        } catch {
          // Already closed.
        }
        void micPromise.then(
          (late) => {
            for (const track of late.getAudioTracks()) {
              try {
                track.stop();
              } catch {
                // Already stopped.
              }
            }
          },
          () => undefined,
        );
        return;
      }
      channel = data;
      data.onmessage = (message) => {
        if (typeof message.data === "string") handleEvent(message.data);
      };
      data.onclose = () => {
        const current = readStatus();
        if (current === "closing") {
          // Graceful wait lost its channel before session.closed. Final usage
          // is unconfirmed; release locally with the honest pending reason.
          const reason = pendingCloseReason ?? "user";
          resolveClosed?.();
          resolveClosed = null;
          clearCloseTimer();
          teardown();
          if (readStatus() !== "failed") setStatus("idle");
          notifyClosed(reason);
          return;
        }
        if (current === "live" || current === "connecting") {
          // No auto-reconnect: a new billed session needs explicit start.
          fail("The live voice connection closed.");
        }
      };
      data.onerror = () => {
        // Socket errors surface through onclose; keep one failure path.
      };
      nextPeer.ontrack = (event) => {
        if (gen !== generation) return;
        const remote = (event.streams?.[0] ??
          browser.createMediaStream(event.track)) as CirceLiveVoiceMediaStream;
        element.srcObject = remote;
        levelMeter?.attach(remote);
        void element.play().catch(() => {
          options.onFailure?.("Select play to hear Circe.");
        });
      };
      emitStage("mic-requested");
      const media = await cancellable(micPromise, gen);
      if (media === null) {
        // Cancelled while the permission prompt was open: release the late
        // microphone so it never stays live after the user stopped.
        void micPromise.then(
          (late) => {
            for (const track of late.getAudioTracks()) {
              try {
                track.stop();
              } catch {
                // Already stopped.
              }
            }
          },
          () => undefined,
        );
        return;
      }
      if (gen !== generation || peer !== nextPeer) {
        for (const track of media.getAudioTracks()) {
          try {
            track.stop();
          } catch {
            // Already stopped.
          }
        }
        return;
      }
      stream = media;
      levelMeter?.attach(media);
      for (const track of media.getAudioTracks()) nextPeer.addTrack(track, media);
      emitStage("media-ready");

      const offer = await cancellable(nextPeer.createOffer(), gen);
      if (offer === null || gen !== generation || peer !== nextPeer) return;
      if (offer.sdp === undefined || offer.sdp.length === 0) {
        throw new Error("The WebRTC offer was empty.");
      }
      const localDone = await cancellable(
        nextPeer.setLocalDescription({ type: "offer", sdp: offer.sdp }),
        gen,
      );
      if (localDone === null || gen !== generation || peer !== nextPeer) return;
      const iceOk = await cancellable(
        waitForIceGathering(nextPeer, options.iceGatheringTimeoutMs ?? 10_000, gen),
        gen,
      );
      if (iceOk === null || gen !== generation || peer !== nextPeer) return;
      if (!iceOk) {
        // Proceeding with half-gathered candidates burns a billed init for a
        // connection unlikely to speak. Fail fast instead.
        fail("Live voice could not gather a network connection in time.");
        return;
      }
      emitStage("offer-ready");

      if (readStatus() !== "requesting") return;
      setStatus("connecting");
      const context = options.context?.()?.trim();
      const creating = options
        .start({
          sdpOffer: nextPeer.localDescription?.sdp ?? offer.sdp,
          ...(context === undefined || context.length === 0 ? {} : { context }),
        })
        .then((result) => {
          liveSessionId = result.sessionId;
          if (result.releaseRequired) {
            if (gen !== generation || peer !== nextPeer) void releaseSession(result.sessionId);
            else cloudSessionId = result.sessionId;
          }
          return result;
        });
      sessionCreation = creating;
      const started = await cancellable(creating, gen);
      if (started !== null && sessionCreation === creating) sessionCreation = null;
      if (started === null || gen !== generation || peer !== nextPeer) {
        // Late or cancelled RPC after the user stopped: suppress the answer
        // so a billed session created upstream cannot flip this client live.
        return;
      }
      const remoteDone = await cancellable(
        nextPeer.setRemoteDescription({ type: "answer", sdp: started.sdpAnswer }),
        gen,
      );
      if (remoteDone === null || gen !== generation || peer !== nextPeer) return;
      emitStage("session-connecting");
      // The HTTP request started the session. Never send session.start on the
      // data channel. session.started gates application commands.
    } catch (error) {
      if (gen !== generation) return;
      fail(errorMessage(error));
    }
  };

  const close = async (): Promise<void> => closeInternal("user");

  return {
    start,
    close,
    speak: (text) => queueAppend("commentary", text),
    note: (text) => queueAppend("thinking", text),
    getStatus: () => status,
    getTranscript: () => transcript,
  };
}

/**
 * A bounded snapshot of app state for the live model. Reference data only:
 * the Director still resolves every name against the real catalog. Catalog
 * spelling and established aliases help the model hear invented project
 * names correctly; they never authorize a route.
 */
export function buildCirceLiveVoiceContext(input: {
  readonly nodeLabels: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<{
    readonly title: string;
    readonly repositoryNames?: ReadonlyArray<string>;
    readonly aliases?: ReadonlyArray<string>;
  }>;
  readonly providerNames: ReadonlyArray<string>;
  readonly currentProjectTitle?: string;
  readonly currentTaskTitle?: string;
  /** The default agent model new tasks use, for "what model are you" answers. */
  readonly currentModel?: string;
  readonly runningTaskCount?: number;
  readonly recentTasks?: ReadonlyArray<{
    readonly title: string;
    readonly project?: string;
    readonly state?: string;
    readonly provider?: string;
  }>;
}): string | undefined {
  const lines: string[] = [];
  if (input.nodeLabels.length > 0) lines.push(`Connected nodes: ${input.nodeLabels.join(", ")}.`);
  if (input.currentProjectTitle !== undefined) {
    lines.push(`Current project: ${input.currentProjectTitle}.`);
  }
  if (input.currentTaskTitle !== undefined) {
    lines.push(`Current task: ${input.currentTaskTitle}.`);
  }
  if (input.projects.length > 0) {
    const projects = input.projects.slice(0, 12).map((project) => {
      const seen = new Set([project.title.trim().toLocaleLowerCase("en-US")]);
      const alternates = [...(project.repositoryNames ?? []), ...(project.aliases ?? [])].filter(
        (name) => {
          const folded = name.trim().toLocaleLowerCase("en-US");
          if (folded.length === 0 || seen.has(folded)) return false;
          seen.add(folded);
          return true;
        },
      );
      return alternates.length === 0
        ? project.title
        : `${project.title} (also: ${alternates.slice(0, 4).join(", ")})`;
    });
    lines.push(`Known projects: ${projects.join("; ")}.`);
  }
  if (input.providerNames.length > 0) {
    lines.push(`Available providers: ${input.providerNames.slice(0, 8).join(", ")}.`);
  }
  if (input.currentModel !== undefined && input.currentModel.trim().length > 0) {
    lines.push(`Default agent model for new work: ${input.currentModel.trim()}.`);
  }
  if (input.runningTaskCount !== undefined) {
    lines.push(`Tasks running right now: ${input.runningTaskCount}.`);
  }
  if (input.recentTasks !== undefined && input.recentTasks.length > 0) {
    const tasks = input.recentTasks.slice(0, 8).map((task) => {
      const qualifiers = [task.project, task.state, task.provider].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      return qualifiers.length === 0 ? task.title : `${task.title} (${qualifiers.join(", ")})`;
    });
    lines.push(`Recent work: ${tasks.join("; ")}.`);
  }
  if (lines.length === 0) return undefined;
  // The wire contract rejects longer context: keep the bounded prefix rather
  // than failing session start over an oversized catalog line.
  return lines.join("\n").slice(0, CIRCE_LIVE_VOICE_MAX_CONTEXT_LENGTH);
}
