import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";
import type { MobileSpeechRequest } from "./mobileSpeechGate";
import { mobileSpeechThreadKey } from "./mobileSpeechGate";

const state = vi.hoisted(() => ({
  streamCalls: [] as Array<{
    readonly text: string;
    readonly signal: AbortSignal;
    readonly onAudio: (chunk: {
      readonly sequence: number;
      readonly sampleRate: number;
      readonly channels: number;
      readonly pcmBase64: string;
    }) => Promise<void>;
    readonly settle: (value: unknown) => void;
  }>,
  playerCalls: [] as Array<{ readonly op: string; readonly id: string }>,
  messages: [] as string[],
  audioModeCalls: 0,
  streamStartCalls: 0,
  uuids: 0,
  appActive: true,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return {
    ...actual,
    ...reactHookHarness,
    useEffect: () => undefined,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../lib/uuid", () => ({ uuidv4: () => `playback-${(state.uuids += 1)}` }));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return state.appActive ? "active" : "background";
    },
    addEventListener: () => ({ remove: () => {} }),
  },
  Platform: { OS: "ios" },
}));
vi.mock("expo-audio", () => ({
  getRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  requestRecordingPermissionsAsync: async () => ({ granted: true }),
  setAudioModeAsync: async () => {
    state.audioModeCalls += 1;
  },
  useAudioStream: () => ({
    stream: {
      start: async () => {
        state.streamStartCalls += 1;
      },
      stop: () => undefined,
    },
  }),
}));
vi.mock("expo-file-system", () => ({
  File: class {
    uri = "file:///mock.wav";
    write() {}
    delete() {}
  },
  Directory: class {},
  Paths: { cache: "file:///cache/" },
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: async () => undefined,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ _tag: "Success", value: {} }),
  useAtomSet: () => () => undefined,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences",
  updateMobilePreferencesAtom: "save",
}));
vi.mock("../../state/jarvisMesh", () => ({
  jarvisMeshEnvironment: { transcribeVoice: "transcribe", streamVoice: "stream" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAbortableAtomCommand: (key: string) =>
    key === "stream"
      ? async (
          input: {
            readonly nodeId: unknown;
            readonly input: { readonly text: string };
            readonly onAudio: (chunk: {
              readonly sequence: number;
              readonly sampleRate: number;
              readonly channels: number;
              readonly pcmBase64: string;
            }) => Promise<void>;
          },
          signal: AbortSignal,
        ) => {
          const gate = deferred<unknown>();
          const call = {
            text: input.input.text,
            signal,
            onAudio: input.onAudio,
            settle: gate.resolve,
          };
          state.streamCalls.push(call);
          signal.addEventListener("abort", () => {
            gate.reject(new Error("Speech was cancelled."));
          });
          return gate.promise;
        }
      : async () => ({ _tag: "Failure", cause: Cause.fail(new Error("not under test")) }),
}));
vi.mock("./mobilePcmPlayer", () => ({
  getMobilePcmPlayer: () => ({
    begin: async (id: string) => {
      state.playerCalls.push({ op: "begin", id });
    },
    write: async (id: string) => {
      state.playerCalls.push({ op: "write", id });
    },
    end: async (id: string) => {
      state.playerCalls.push({ op: "end", id });
    },
    stop: (id: string) => {
      state.playerCalls.push({ op: "stop", id });
    },
  }),
}));

import { useJarvisVoice } from "./useJarvisVoice";

const voiceNodeId = EnvironmentId.make("voice-node");
const executionNodeId = EnvironmentId.make("node-A");
const threadKey = (thread: string): string =>
  mobileSpeechThreadKey(executionNodeId, ThreadId.make(thread));

function turnId(id: string): TurnId {
  return TurnId.make(id);
}

function speech(
  speechKey: string,
  thread: string,
  text = `Speech ${speechKey}.`,
  extra?: Pick<MobileSpeechRequest, "turnId" | "requestId" | "originInteractionId" | "terminal">,
): MobileSpeechRequest {
  return { text, nodeId: voiceNodeId, speechKey, threadKey: threadKey(thread), ...extra };
}

function renderWithNodes(nodes: Parameters<typeof useJarvisVoice>[0]["nodes"]) {
  hooks.beginRender();
  return useJarvisVoice({
    nodes,
    onMessage: (message: string) => {
      state.messages.push(message);
    },
    onTranscript: async () => undefined,
  });
}

function render() {
  hooks.beginRender();
  return useJarvisVoice({
    nodes: [
      {
        nodeId: voiceNodeId,
        label: "Desk",
        reachability: "online",
        capabilities: { voiceCompute: true } as never,
      },
    ],
    onMessage: (message: string) => {
      state.messages.push(message);
    },
    onTranscript: async () => undefined,
  });
}

async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function audioChunk(sequence = 0) {
  return { sequence, sampleRate: 24_000, channels: 1, pcmBase64: "AAA=" };
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.streamCalls = [];
  state.playerCalls = [];
  state.messages = [];
  state.audioModeCalls = 0;
  state.streamStartCalls = 0;
  state.uuids = 0;
  state.appActive = true;
});

describe("mobile voice playback invalidation", () => {
  it("kills late synthesis before it becomes audible when the thread turns over", async () => {
    const voice = render();
    voice.enqueueSpeech(speech("request-1:started", "thread-A", "Taking a look at auth."));
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));

    voice.enqueueSpeech(speech("presentation-9", "thread-A", "Auth review done."));
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(2));
    expect(state.streamCalls[0]?.signal.aborted).toBe(true);

    // The superseded synthesis resolves late: nothing audible may follow.
    const playerCallsBefore = state.playerCalls.length;
    state.streamCalls[0]?.settle({ _tag: "Success", value: { status: "done" } });
    await flush();
    expect(state.playerCalls.length).toBe(playerCallsBefore);
    expect(state.messages).toEqual([]);

    // The terminal completes audibly.
    await state.streamCalls[1]?.onAudio(audioChunk(0));
    state.streamCalls[1]?.settle({ _tag: "Success", value: { status: "done" } });
    await vi.waitFor(() =>
      expect(state.playerCalls.filter((call) => call.op === "end")).toHaveLength(1),
    );
    expect(state.messages).toEqual([]);
    voice.stopSpeech();
  });

  it("skips a queued ack at playback once a terminal for its thread arrives", async () => {
    const voice = render();
    voice.enqueueSpeech(speech("request-1:started", "thread-A", "Taking a look."));
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));
    voice.enqueueSpeech(speech("request-2:needs-input", "thread-A", "Which provider?"));
    voice.enqueueSpeech(speech("presentation-9", "thread-A", "Auth review done."));
    await flush();

    // The playing ack and the queued prompt both die; only the terminal synthesizes.
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(2));
    expect(state.streamCalls.map((call) => call.text)).toEqual([
      "Taking a look.",
      "Auth review done.",
    ]);
    state.streamCalls[0]?.settle({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
    await state.streamCalls[1]?.onAudio(audioChunk(0));
    state.streamCalls[1]?.settle({ _tag: "Success", value: { status: "done" } });
    await vi.waitFor(() =>
      expect(state.playerCalls.filter((call) => call.op === "end")).toHaveLength(1),
    );
    expect(state.messages).toEqual([]);
    voice.stopSpeech();
  });

  it("speaks an exact re-delivery once even across completion-before-ack", async () => {
    const voice = render();
    voice.enqueueSpeech(speech("presentation-9", "thread-A", "Auth review done."));
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));
    voice.enqueueSpeech(speech("presentation-9", "thread-A", "Auth review done."));
    await flush();
    expect(state.streamCalls).toHaveLength(1);
    state.streamCalls[0]?.settle({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
    await flush();
    expect(state.messages).toEqual(["offline"]);
    voice.stopSpeech();
  });

  it("keeps an unrelated thread playing while another thread turns over", async () => {
    const voice = render();
    voice.enqueueSpeech(speech("presentation-1", "thread-A", "First thread update."));
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));
    voice.enqueueSpeech({
      text: "Second thread update.",
      nodeId: voiceNodeId,
      speechKey: "presentation-2",
      threadKey: mobileSpeechThreadKey(EnvironmentId.make("node-B"), ThreadId.make("thread-B")),
    });
    await flush();
    expect(state.streamCalls).toHaveLength(1);
    expect(state.streamCalls[0]?.signal.aborted).toBe(false);

    await state.streamCalls[0]?.onAudio(audioChunk(0));
    state.streamCalls[0]?.settle({ _tag: "Success", value: { status: "done" } });
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(2));
    expect(state.messages).toEqual([]);
    voice.stopSpeech();
  });

  it("stays silent when a stop cancels synthesis", async () => {
    const voice = render();
    voice.enqueueSpeech(speech("request-1:started", "thread-A", "Taking a look."));
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));
    voice.stopSpeech();
    expect(state.streamCalls[0]?.signal.aborted).toBe(true);
    await flush();
    expect(state.messages).toEqual([]);
    expect(render().phase).toBe("idle");
  });

  it("drops a delayed ack when its turn terminal arrived first", async () => {
    const voice = render();
    voice.enqueueSpeech(
      speech("presentation-9", "thread-A", "Auth review done.", {
        turnId: turnId("turn-1"),
        terminal: true,
      }),
    );
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));
    voice.enqueueSpeech(
      speech("request-1:started", "thread-A", "Taking a look.", {
        turnId: turnId("turn-1"),
        requestId: "request-1",
      }),
    );
    await flush();
    expect(state.streamCalls.map((call) => call.text)).toEqual(["Auth review done."]);
    await state.streamCalls[0]?.onAudio(audioChunk(0));
    state.streamCalls[0]?.settle({ _tag: "Success", value: { status: "done" } });
    await vi.waitFor(() =>
      expect(state.playerCalls.filter((call) => call.op === "end")).toHaveLength(1),
    );
    expect(state.messages).toEqual([]);
    voice.stopSpeech();
  });

  it("allows a later legitimate turn on the same task after its terminal", async () => {
    const voice = render();
    voice.enqueueSpeech(
      speech("presentation-9", "thread-A", "Auth review done.", {
        turnId: turnId("turn-1"),
        terminal: true,
      }),
    );
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));
    voice.enqueueSpeech(
      speech("request-2:started", "thread-A", "On the follow-up.", {
        turnId: turnId("turn-2"),
        requestId: "request-2",
      }),
    );
    await flush();
    expect(state.streamCalls).toHaveLength(1);
    await state.streamCalls[0]?.onAudio(audioChunk(0));
    state.streamCalls[0]?.settle({ _tag: "Success", value: { status: "done" } });
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(2));
    expect(state.streamCalls[1]?.text).toBe("On the follow-up.");
    await state.streamCalls[1]?.onAudio(audioChunk(0));
    state.streamCalls[1]?.settle({ _tag: "Success", value: { status: "done" } });
    await vi.waitFor(() =>
      expect(state.playerCalls.filter((call) => call.op === "end")).toHaveLength(2),
    );
    expect(state.messages).toEqual([]);
    voice.stopSpeech();
  });

  it("allows a later legitimate turn sharing one originInteractionId", async () => {
    const voice = render();
    voice.enqueueSpeech(
      speech("presentation-9", "thread-A", "Auth review done.", {
        turnId: turnId("turn-1"),
        originInteractionId: "origin-shared",
        terminal: true,
      }),
    );
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));
    voice.enqueueSpeech(
      speech("request-2:started", "thread-A", "On the follow-up.", {
        turnId: turnId("turn-2"),
        originInteractionId: "origin-shared",
        requestId: "request-2",
      }),
    );
    await flush();
    expect(state.streamCalls).toHaveLength(1);
    await state.streamCalls[0]?.onAudio(audioChunk(0));
    state.streamCalls[0]?.settle({ _tag: "Success", value: { status: "done" } });
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(2));
    expect(state.streamCalls[1]?.text).toBe("On the follow-up.");
    await state.streamCalls[1]?.onAudio(audioChunk(0));
    state.streamCalls[1]?.settle({ _tag: "Success", value: { status: "done" } });
    await vi.waitFor(() =>
      expect(state.playerCalls.filter((call) => call.op === "end")).toHaveLength(2),
    );
    expect(state.messages).toEqual([]);
    voice.stopSpeech();
  });

  it("kills late chunks for a superseded ack when its terminal lands mid-synthesis", async () => {
    const voice = render();
    voice.enqueueSpeech(
      speech("request-1:started", "thread-A", "Taking a look.", {
        turnId: turnId("turn-1"),
        requestId: "request-1",
      }),
    );
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));
    await state.streamCalls[0]?.onAudio(audioChunk(0));
    voice.enqueueSpeech(
      speech("presentation-9", "thread-A", "Auth review done.", {
        turnId: turnId("turn-1"),
        terminal: true,
      }),
    );
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(2));
    expect(state.streamCalls[0]?.signal.aborted).toBe(true);
    await expect(state.streamCalls[0]?.onAudio(audioChunk(1))).rejects.toThrow();
    await state.streamCalls[1]?.onAudio(audioChunk(0));
    state.streamCalls[1]?.settle({ _tag: "Success", value: { status: "done" } });
    await vi.waitFor(() =>
      expect(state.playerCalls.filter((call) => call.op === "end")).toHaveLength(1),
    );
    expect(state.messages).toEqual([]);
    voice.stopSpeech();
  });

  it("stays idle with no voice node and never synthesizes", async () => {
    const voice = renderWithNodes([
      {
        nodeId: executionNodeId,
        label: "No voice",
        reachability: "online",
        capabilities: {} as never,
      },
    ]);
    voice.enqueueSpeech(speech("presentation-9", "thread-A", "Auth review done."));
    await flush();
    expect(state.streamCalls).toHaveLength(0);
    expect(state.playerCalls).toHaveLength(0);
    expect(state.messages).toEqual([]);
    voice.stopSpeech();
  });

  it("never re-speaks an exact re-delivery after a stop", async () => {
    const voice = render();
    voice.enqueueSpeech(
      speech("presentation-9", "thread-A", "Auth review done.", {
        turnId: turnId("turn-1"),
        terminal: true,
      }),
    );
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));
    voice.stopSpeech();
    await flush();
    voice.enqueueSpeech(
      speech("presentation-9", "thread-A", "Auth review done.", {
        turnId: turnId("turn-1"),
        terminal: true,
      }),
    );
    await flush();
    expect(state.streamCalls).toHaveLength(1);
    expect(state.messages).toEqual([]);
  });

  it("keeps the next playback slot when a stale item settles first", async () => {
    const voice = render();
    const turn = turnId("turn-stale-settle");
    voice.enqueueSpeech(
      speech("request-1:started", "thread-A", "Taking a look.", { turnId: turn }),
    );
    // The terminal lands while the first item is still preparing: the stale
    // item settles via settleStale, and the terminal must keep its slot so
    // stopSpeech can still abort the live synthesis.
    voice.enqueueSpeech(
      speech("presentation-9", "thread-A", "Auth review done.", {
        turnId: turn,
        terminal: true,
      }),
    );
    await vi.waitFor(() => expect(state.streamCalls).toHaveLength(1));
    expect(state.streamCalls[0]?.text).toBe("Auth review done.");
    await flush();
    voice.stopSpeech();
    expect(state.streamCalls[0]?.signal.aborted).toBe(true);
  });
});
