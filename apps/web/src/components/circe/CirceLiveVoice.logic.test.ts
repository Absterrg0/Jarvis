import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildCirceLiveVoiceContext,
  createCirceLiveVoiceController,
  CIRCE_LIVE_VOICE_DEFAULT_IDLE_TIMEOUT_MS,
  CIRCE_LIVE_VOICE_DEFAULT_MAX_SESSION_MS,
  type CirceLiveVoiceAudioElement,
  type CirceLiveVoiceBrowser,
  type CirceLiveVoiceCloseReason,
  type CirceLiveVoiceDataChannel,
  type CirceLiveVoiceMediaStream,
  type CirceLiveVoiceMediaTrack,
  type CirceLiveVoicePeerConnection,
  type CirceLiveVoiceStartResult,
  type CirceLiveVoiceStartupStage,
  type CirceLiveVoiceStatus,
} from "./CirceLiveVoice.logic";

class FakeTrack implements CirceLiveVoiceMediaTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream implements CirceLiveVoiceMediaStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getAudioTracks() {
    return this.tracks;
  }
}

class FakeChannel implements CirceLiveVoiceDataChannel {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = "connecting";
  readonly sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = "closed";
  }
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  emitRaw(data: unknown) {
    this.onmessage?.({ data });
  }
  events(): Array<Record<string, unknown>> {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

class FakeAudio implements CirceLiveVoiceAudioElement {
  autoplay = false;
  srcObject: unknown = null;
  played = 0;
  async play() {
    this.played += 1;
  }
}

class FakePeer implements CirceLiveVoicePeerConnection {
  ontrack: CirceLiveVoicePeerConnection["ontrack"] = null;
  localDescription: { readonly sdp?: string } | null = null;
  iceGatheringState = "complete";
  readonly channel = new FakeChannel();
  readonly addedTracks: unknown[] = [];
  remote: { readonly type: "answer"; readonly sdp: string } | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: "icegatheringstatechange", listener: () => void) {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: "icegatheringstatechange", listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  iceListenerCount() {
    return this.listeners.get("icegatheringstatechange")?.size ?? 0;
  }
  completeIce() {
    this.iceGatheringState = "complete";
    for (const listener of [...(this.listeners.get("icegatheringstatechange") ?? [])]) {
      listener();
    }
  }
  addTrack(track: unknown) {
    this.addedTracks.push(track);
  }
  createDataChannel() {
    this.channel.readyState = "open";
    return this.channel;
  }
  async createOffer() {
    return { sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=offer\r\n" };
  }
  async setLocalDescription(description: { readonly type: "offer"; readonly sdp: string }) {
    this.localDescription = { sdp: description.sdp };
  }
  async setRemoteDescription(description: { readonly type: "answer"; readonly sdp: string }) {
    this.remote = description;
  }
  close() {
    this.closed = true;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function fixture(
  options: {
    readonly start?: (input: {
      sdpOffer: string;
      context?: string;
    }) => Promise<CirceLiveVoiceStartResult>;
    readonly delegate?: (utterance: string, delegationId: string) => boolean;
    readonly idleTimeoutMs?: number;
    readonly maxSessionMs?: number;
    readonly startupTimeoutMs?: number;
    readonly closeTimeoutMs?: number;
    readonly now?: () => number;
    readonly onClosed?: (reason: CirceLiveVoiceCloseReason) => void;
    readonly onStage?: (stage: CirceLiveVoiceStartupStage, atMs: number) => void;
    readonly getUserMedia?: () => Promise<CirceLiveVoiceMediaStream>;
    readonly iceGatheringTimeoutMs?: number;
    readonly peer?: FakePeer;
    readonly listen?: boolean;
  } = {},
) {
  const peer = options.peer ?? new FakePeer();
  const audio = new FakeAudio();
  const tracks = [new FakeTrack()];
  const stream = new FakeStream(tracks);
  const silentTracks = [new FakeTrack()];
  const silentStream = new FakeStream(silentTracks);
  const startCalls: Array<{ sdpOffer: string; context?: string }> = [];
  const statuses: CirceLiveVoiceStatus[] = [];
  const failures: string[] = [];
  const closed: CirceLiveVoiceCloseReason[] = [];
  const stages: Array<{ stage: CirceLiveVoiceStartupStage; atMs: number }> = [];
  const browserCalls = { mic: 0, silent: 0 };
  const browser: CirceLiveVoiceBrowser = {
    createPeerConnection: () => peer,
    createAudioElement: () => audio,
    createMediaStream: () => stream,
    getUserMedia: () => {
      browserCalls.mic += 1;
      return options.getUserMedia?.() ?? Promise.resolve(stream);
    },
    createSilentStream: () => {
      browserCalls.silent += 1;
      return silentStream;
    },
    createId: (() => {
      let next = 0;
      return () => `id-${(next += 1)}`;
    })(),
  };
  const controller = createCirceLiveVoiceController({
    start: async (input) => {
      startCalls.push(input);
      return (
        options.start?.(input) ?? {
          sessionId: "live_1",
          sdpAnswer: "v=0\r\ns=answer\r\n",
          model: "gpt-live-1",
          voice: "marin",
        }
      );
    },
    delegate: options.delegate ?? (() => true),
    onStatus: (status) => statuses.push(status),
    onFailure: (message) => failures.push(message),
    onClosed: (reason) => {
      closed.push(reason);
      options.onClosed?.(reason);
    },
    onStage: (stage, atMs) => {
      stages.push({ stage, atMs });
      options.onStage?.(stage, atMs);
    },
    context: () => "Focused project: circe.",
    browser,
    closeTimeoutMs: options.closeTimeoutMs ?? 1,
    ...(options.iceGatheringTimeoutMs === undefined
      ? {}
      : { iceGatheringTimeoutMs: options.iceGatheringTimeoutMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.maxSessionMs === undefined ? {} : { maxSessionMs: options.maxSessionMs }),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.listen === undefined ? {} : { listen: options.listen }),
  });
  return {
    controller,
    peer,
    audio,
    tracks,
    silentTracks,
    browserCalls,
    startCalls,
    statuses,
    failures,
    closed,
    stages,
  };
}

const started = { type: "session.started", session: { id: "live_1" } };

async function startLive(
  fixtureResult: ReturnType<typeof fixture>,
): Promise<ReturnType<typeof fixture>> {
  await fixtureResult.controller.start();
  fixtureResult.peer.channel.emit(started);
  return fixtureResult;
}

describe("Circe live voice controller", () => {
  it("connects WebRTC, sends the offer, and reports live once the session starts", async () => {
    const { controller, peer, startCalls, statuses } = fixture();
    await controller.start();
    expect(startCalls).toEqual([
      {
        sdpOffer: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=offer\r\n",
        context: "Focused project: circe.",
      },
    ]);
    expect(peer.remote?.sdp).toBe("v=0\r\ns=answer\r\n");
    expect(statuses).toEqual(["requesting", "connecting"]);
    peer.channel.emit(started);
    expect(controller.getStatus()).toBe("live");
    // Documented WebRTC shape: media on tracks, never session.start.
    expect(peer.addedTracks).toHaveLength(1);
    expect(peer.channel.events().some((event) => event.type === "session.start")).toBe(false);
    await controller.close();
  });

  it("announcement sessions skip the microphone, mute input, and flush queued speech", async () => {
    const result = fixture({ listen: false });
    await result.controller.start();
    // A report can arrive while the announcement session is still connecting.
    result.controller.speak("The login fix is done.");
    expect(result.peer.channel.events()).toEqual([]);
    result.peer.channel.emit(started);

    expect(result.browserCalls).toEqual({ mic: 0, silent: 1 });
    const events = result.peer.channel.events();
    expect(events).toContainEqual(expect.objectContaining({ type: "session.input_audio.mute" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.commentary.append",
        content: "The login fix is done.",
      }),
    );
    await result.controller.close();
  });

  it("delegates user transcript and can answer for a rejected delegation", async () => {
    const delegated: Array<{ utterance: string; delegationId: string }> = [];
    const { controller, peer } = fixture({
      delegate: (utterance, delegationId) => {
        delegated.push({ utterance, delegationId });
        return false;
      },
    });
    await controller.start();
    peer.channel.emit(started);
    peer.channel.emit({ type: "session.input_transcript.delta", delta: "fix the " });
    peer.channel.emit({ type: "session.input_transcript.delta", delta: "login bug" });
    peer.channel.emit({
      type: "session.delegation.created",
      delegation: { id: "item_1", type: "delegation", target: "client" },
    });
    expect(delegated).toEqual([{ utterance: "fix the login bug", delegationId: "item_1" }]);
    const commentary = peer.channel
      .events()
      .find(
        (event) => event.type === "session.commentary.append" && event.delegation_id === "item_1",
      );
    expect(commentary).toMatchObject({
      delegation_id: "item_1",
      content: "I could not submit that request on this device.",
    });
    await controller.close();
  });

  it("does not replay the transcript when a delegation has no new speech", async () => {
    const delegated: string[] = [];
    const f = fixture({
      delegate: (utterance) => {
        delegated.push(utterance);
        return true;
      },
    });
    await f.controller.start();
    f.peer.channel.emit(started);
    f.peer.channel.emit({ type: "session.input_transcript.delta", delta: "fix login" });
    f.peer.channel.emit({
      type: "session.delegation.created",
      delegation: { id: "item_1", target: "client" },
    });
    expect(delegated).toEqual(["fix login"]);
    f.peer.channel.emit({
      type: "session.delegation.created",
      delegation: { id: "item_2", target: "client" },
    });
    expect(delegated).toEqual(["fix login"]);
    await f.controller.close();
  });

  it("holds a delegation until its transcript delta arrives", async () => {
    const delegated: Array<{ utterance: string; delegationId: string }> = [];
    const f = fixture({
      delegate: (utterance, delegationId) => {
        delegated.push({ utterance, delegationId });
        return true;
      },
    });
    await f.controller.start();
    f.peer.channel.emit(started);
    // The model can ask for backend help before the input transcript lands.
    f.peer.channel.emit({
      type: "session.delegation.created",
      delegation: { id: "item_held", target: "client" },
    });
    expect(delegated).toEqual([]);
    f.peer.channel.emit({ type: "session.input_transcript.delta", delta: "gujarat" });
    expect(delegated).toEqual([{ utterance: "gujarat", delegationId: "item_held" }]);
    await f.controller.close();
  });

  it("delegates the last utterance when the model refuses for lack of tools", async () => {
    const delegated: string[] = [];
    const f = fixture({
      delegate: (utterance) => {
        delegated.push(utterance);
        return true;
      },
    });
    await f.controller.start();
    f.peer.channel.emit(started);
    f.peer.channel.emit({
      type: "session.input_transcript.delta",
      delta: "what's the weather in ahmedabad",
    });
    f.peer.channel.emit({
      type: "session.output_transcript.delta",
      delta: "I don't have live weather access right now.",
    });
    expect(delegated).toEqual(["what's the weather in ahmedabad"]);
    // One auto-delegation per user turn: the rest of the refusal is ignored.
    f.peer.channel.emit({
      type: "session.output_transcript.delta",
      delta: " Please check a weather app.",
    });
    expect(delegated).toHaveLength(1);
    await f.controller.close();
  });

  it("does not delegate a normal assistant answer", async () => {
    const delegated: string[] = [];
    const f = fixture({
      delegate: (utterance) => {
        delegated.push(utterance);
        return true;
      },
    });
    await f.controller.start();
    f.peer.channel.emit(started);
    f.peer.channel.emit({ type: "session.input_transcript.delta", delta: "fix the login bug" });
    f.peer.channel.emit({
      type: "session.output_transcript.delta",
      delta: "Sure, I'll take a look at that.",
    });
    expect(delegated).toEqual([]);
    await f.controller.close();
  });

  it("dedupes delegation ids so a retried event cannot double-submit", async () => {
    const delegated: string[] = [];
    const f = fixture({
      delegate: (utterance) => {
        delegated.push(utterance);
        return true;
      },
    });
    await f.controller.start();
    f.peer.channel.emit(started);
    f.peer.channel.emit({ type: "session.input_transcript.delta", delta: "run tests" });
    const created = {
      type: "session.delegation.created",
      delegation: { id: "item_dup", target: "client" },
    };
    f.peer.channel.emit(created);
    f.peer.channel.emit(created);
    expect(delegated).toEqual(["run tests"]);
    await f.controller.close();
  });

  it("ignores non-client delegation targets", async () => {
    let calls = 0;
    const f = fixture({
      delegate: () => {
        calls += 1;
        return true;
      },
    });
    await f.controller.start();
    f.peer.channel.emit(started);
    f.peer.channel.emit({ type: "session.input_transcript.delta", delta: "hello" });
    f.peer.channel.emit({
      type: "session.delegation.created",
      delegation: { id: "item_resp", target: "responses" },
    });
    expect(calls).toBe(0);
    await f.controller.close();
  });

  it("appends commentary and quiet notes to the live model", async () => {
    const { controller, peer } = fixture();
    await controller.start();
    peer.channel.emit(started);
    peer.channel.emit({
      type: "session.delegation.created",
      delegation: { id: "item_1", target: "client" },
    });
    controller.speak("The login fix is done.");
    controller.note("Checking the test run.");
    const events = peer.channel.events();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.commentary.append",
        delegation_id: "item_1",
        content: "The login fix is done.",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.thinking.append",
        delegation_id: "item_1",
        content: "Checking the test run.",
      }),
    );
    await controller.close();
  });

  it("closes the session, stops the microphone, and reports idle", async () => {
    const { controller, peer, tracks, closed } = fixture();
    await controller.start();
    peer.channel.emit(started);
    const closePromise = controller.close();
    // Mic stops immediately instead of after the graceful round trip.
    expect(tracks[0]!.stopped).toBe(true);
    expect(peer.channel.events()).toContainEqual({ type: "session.close" });
    peer.channel.emit({ type: "session.closed", reason: "close_requested" });
    await closePromise;
    expect(peer.closed).toBe(true);
    expect(controller.getStatus()).toBe("idle");
    expect(closed).toEqual(["user"]);
  });

  it("forces release when session.closed never arrives", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ closeTimeoutMs: 1000 });
      await f.controller.start();
      f.peer.channel.emit(started);
      const closePromise = f.controller.close();
      expect(f.tracks[0]!.stopped).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      await closePromise;
      expect(f.controller.getStatus()).toBe("idle");
      expect(f.closed).toEqual(["user"]);
      // Timers are cleared: advancing further never reports twice.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.closed).toEqual(["user"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-closes after 60s without user speech and stays honest", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ closeTimeoutMs: 1 });
      expect(CIRCE_LIVE_VOICE_DEFAULT_IDLE_TIMEOUT_MS).toBe(60_000);
      await f.controller.start();
      f.peer.channel.emit(started);
      expect(f.controller.getStatus()).toBe("live");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.peer.channel.events()).toContainEqual({ type: "session.close" });
      expect(f.tracks[0]!.stopped).toBe(true);
      f.peer.channel.emit({ type: "session.closed", reason: "close_requested" });
      expect(f.controller.getStatus()).toBe("idle");
      expect(f.closed).toEqual(["idle"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the idle clock on user speech", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ closeTimeoutMs: 1, idleTimeoutMs: 60_000 });
      await f.controller.start();
      f.peer.channel.emit(started);
      await vi.advanceTimersByTimeAsync(50_000);
      f.peer.channel.emit({ type: "session.input_transcript.delta", delta: "still here" });
      await vi.advanceTimersByTimeAsync(50_000);
      expect(f.controller.getStatus()).toBe("live");
      expect(f.closed).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.peer.channel.events()).toContainEqual({ type: "session.close" });
      f.peer.channel.emit({ type: "session.closed", reason: "close_requested" });
      expect(f.closed).toEqual(["idle"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces a 10 minute hard cap", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ closeTimeoutMs: 1 });
      expect(CIRCE_LIVE_VOICE_DEFAULT_MAX_SESSION_MS).toBe(600_000);
      await f.controller.start();
      f.peer.channel.emit(started);
      // Keep talking so idle never fires; the hard cap still ends billing.
      for (let elapsed = 0; elapsed < 600_000; elapsed += 50_000) {
        f.peer.channel.emit({ type: "session.input_transcript.delta", delta: "work " });
        await vi.advanceTimersByTimeAsync(50_000);
      }
      expect(f.peer.channel.events()).toContainEqual({ type: "session.close" });
      expect(f.closed).toEqual([]);
      f.peer.channel.emit({ type: "session.closed", reason: "expired" });
      expect(f.controller.getStatus()).toBe("idle");
      expect(f.closed).toEqual(["max-duration"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels startup when the user stops during microphone access", async () => {
    const gate = deferred<CirceLiveVoiceMediaStream>();
    const tracks = [new FakeTrack()];
    const f = fixture({
      closeTimeoutMs: 1,
      getUserMedia: () => gate.promise,
    });
    const startPromise = f.controller.start();
    expect(f.controller.getStatus()).toBe("requesting");
    const closePromise = f.controller.close();
    gate.resolve(new FakeStream(tracks));
    await startPromise;
    await closePromise;
    expect(f.startCalls).toEqual([]);
    expect(f.controller.getStatus()).toBe("idle");
    expect(tracks[0]!.stopped).toBe(true);
    expect(f.closed).toEqual(["user"]);
  });

  it("suppresses a late RPC answer after the user stopped", async () => {
    const gate = deferred<CirceLiveVoiceStartResult>();
    const f = fixture({
      closeTimeoutMs: 1,
      start: () => gate.promise,
    });
    const startPromise = f.controller.start();
    // Let the controller reach the RPC await.
    await Promise.resolve();
    await Promise.resolve();
    const closePromise = f.controller.close();
    gate.resolve({
      sessionId: "live_late",
      sdpAnswer: "v=0\r\ns=late\r\n",
      model: "gpt-live-1",
      voice: "marin",
    });
    await startPromise;
    // No session.closed will arrive for the suppressed answer.
    await vi.waitFor?.(() => undefined).catch(() => undefined);
    await closePromise;
    expect(f.peer.remote).toBeNull();
    expect(f.controller.getStatus()).toBe("idle");
    expect(f.closed).toEqual(["user"]);
  });

  it("does not start a second billed session while one is active", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.start();
    expect(f.startCalls).toHaveLength(1);
    await f.controller.close();
  });

  it("never auto-reconnects a billed session after the socket drops", async () => {
    const f = fixture();
    await startLive(f);
    f.peer.channel.onclose?.();
    expect(f.controller.getStatus()).toBe("failed");
    expect(f.startCalls).toHaveLength(1);
    expect(f.failures).toEqual(["The live voice connection closed."]);
    expect(f.closed).toEqual(["error"]);
  });

  it("reports a remote close without inventing success", async () => {
    const f = fixture();
    await startLive(f);
    f.peer.channel.emit({ type: "session.closed", reason: "connection_lost" });
    expect(f.controller.getStatus()).toBe("idle");
    expect(f.closed).toEqual(["remote"]);
  });

  it("fails visibly when the session cannot be created and tears down", async () => {
    const { controller, peer, failures, tracks, closed } = fixture({
      start: async () => {
        throw new Error("The GPT-Live session could not be created.");
      },
    });
    await controller.start();
    expect(controller.getStatus()).toBe("failed");
    expect(failures).toEqual(["The GPT-Live session could not be created."]);
    expect(peer.closed).toBe(true);
    expect(tracks[0]!.stopped).toBe(true);
    expect(closed).toEqual(["error"]);
  });

  it("times out a stuck startup instead of billing forever", async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<CirceLiveVoiceStartResult>();
      const f = fixture({ startupTimeoutMs: 1000, start: () => gate.promise });
      const startPromise = f.controller.start();
      await vi.advanceTimersByTimeAsync(1000);
      await startPromise;
      expect(f.controller.getStatus()).toBe("failed");
      expect(f.closed).toEqual(["error"]);
      gate.resolve({
        sessionId: "live_late",
        sdpAnswer: "v=0\r\ns=late\r\n",
        model: "gpt-live-1",
        voice: "marin",
      });
      await Promise.resolve();
      expect(f.peer.remote).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops speak and note before session.started", async () => {
    const f = fixture();
    await f.controller.start();
    expect(f.controller.getStatus()).toBe("connecting");
    f.controller.speak("Too early.");
    f.controller.note("Still early.");
    expect(
      f.peer.channel.events().some((event) => event.type === "session.commentary.append"),
    ).toBe(false);
    expect(f.peer.channel.events().some((event) => event.type === "session.thinking.append")).toBe(
      false,
    );
    f.peer.channel.emit(started);
    f.controller.speak("On time.");
    expect(f.peer.channel.events()).toContainEqual(
      expect.objectContaining({
        type: "session.commentary.append",
        content: "On time.",
      }),
    );
    await f.controller.close();
  });

  it("fails fast when ICE gathering times out instead of billing a bad offer", async () => {
    const peer = new FakePeer();
    peer.iceGatheringState = "new";
    const f = fixture({ peer, iceGatheringTimeoutMs: 20 });
    await f.controller.start();
    expect(f.controller.getStatus()).toBe("failed");
    expect(f.startCalls).toEqual([]);
    expect(f.failures).toEqual(["Live voice could not gather a network connection in time."]);
    expect(peer.iceListenerCount()).toBe(0);
  });

  it("releases the ICE timer and listener when startup is cancelled", async () => {
    const peer = new FakePeer();
    peer.iceGatheringState = "new";
    const f = fixture({ peer, iceGatheringTimeoutMs: 60_000, closeTimeoutMs: 1 });
    const startPromise = f.controller.start();
    // Let the controller reach the ICE wait. All fakes resolve in microtasks,
    // so one macrotask flush is enough.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peer.iceListenerCount()).toBe(1);
    const closePromise = f.controller.close();
    expect(peer.iceListenerCount()).toBe(0);
    f.peer.channel.emit({ type: "session.closed", reason: "close_requested" });
    await startPromise;
    await closePromise;
    expect(f.startCalls).toEqual([]);
    expect(f.controller.getStatus()).toBe("idle");
  });

  it("creates the data channel before the microphone resolves", async () => {
    const gate = deferred<CirceLiveVoiceMediaStream>();
    const peer = new FakePeer();
    const f = fixture({ peer, getUserMedia: () => gate.promise });
    const startPromise = f.controller.start();
    await Promise.resolve();
    await Promise.resolve();
    // Mic still pending, no billed RPC yet, but local prep is done.
    expect(peer.channel.readyState).toBe("open");
    expect(f.startCalls).toEqual([]);
    expect(f.stages.map((entry) => entry.stage)).toContain("mic-requested");
    gate.resolve(new FakeStream([new FakeTrack()]));
    await startPromise;
    expect(f.startCalls).toHaveLength(1);
    await f.controller.close();
  });

  it("records startup stages in order with monotonic timestamps", async () => {
    const gate = deferred<CirceLiveVoiceMediaStream>();
    let tick = 0;
    const f = fixture({
      getUserMedia: () => gate.promise,
      now: () => (tick += 10),
    });
    const startPromise = f.controller.start();
    await Promise.resolve();
    await Promise.resolve();
    gate.resolve(new FakeStream([new FakeTrack()]));
    await startPromise;
    expect(f.stages.map((entry) => entry.stage)).toEqual([
      "mic-requested",
      "media-ready",
      "offer-ready",
      "session-connecting",
    ]);
    const times = f.stages.map((entry) => entry.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
    await f.controller.close();
  });

  it("keeps the context builder bounded and reference-only", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ title: `project-${index}` }));
    const context = buildCirceLiveVoiceContext({
      nodeLabels: ["desk"],
      projects: many,
      providerNames: ["Codex"],
      currentProjectTitle: "Rivvl",
      currentTaskTitle: "Check pull requests",
    });
    expect(context).toContain("Connected nodes: desk.");
    expect(context).toContain("Current project: Rivvl.");
    expect(context).toContain("Current task: Check pull requests.");
    expect(context).toContain("project-0");
    expect(context).not.toContain("project-39");
    expect(
      buildCirceLiveVoiceContext({ nodeLabels: [], projects: [], providerNames: [] }),
    ).toBeUndefined();
  });

  it("carries catalog spelling and established aliases as reference data", () => {
    const context = buildCirceLiveVoiceContext({
      nodeLabels: [],
      projects: [
        { title: "Rivvl", repositoryNames: ["rivvl-repo"], aliases: ["reveal", "zivil"] },
        { title: "Alertify", aliases: ["alert effect"] },
      ],
      providerNames: [],
    });
    expect(context).toBe(
      [
        "Known projects: Rivvl (also: rivvl-repo, reveal, zivil); Alertify (also: alert effect).",
      ].join("\n"),
    );
  });
});
