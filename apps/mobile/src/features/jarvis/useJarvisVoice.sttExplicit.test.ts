/**
 * Negative regression tests for explicit STT selection in `useJarvisVoice`.
 *
 * Required behavior:
 * - explicit local/remote choice, never automatic override to local;
 * - local input works with no voice node through onTranscript;
 * - live on-device sessions never use a fake file URI sentinel;
 * - failed local work never uploads audio or falls back to remote;
 * - TTS stays gated on the selected voice node while STT runs locally.
 *
 * No microphone, recognizer, or network runs. Physical-device proof is out
 * of scope here.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";

const state = vi.hoisted(() => ({
  messages: [] as string[],
  transcripts: [] as Array<{ text: string; voiceNodeId: unknown }>,
  transcribeUris: [] as unknown[],
  remoteCalls: 0,
  prepareCalls: 0,
  streamStartCalls: 0,
  streamBuffers: [] as Array<
    (buffer: { data: ArrayBuffer; sampleRate: number; channels: number }) => void
  >,
  localTranscript: "local hello",
  appActive: true,
}));

function pcmBuffer(bytes: number[]): { data: ArrayBuffer; sampleRate: number; channels: number } {
  return { data: new Uint8Array(bytes).buffer as ArrayBuffer, sampleRate: 16_000, channels: 1 };
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
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "test-uuid" }));
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
  requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  setAudioModeAsync: async () => undefined,
  useAudioStream: (options: {
    onBuffer: (buffer: { data: ArrayBuffer; sampleRate: number; channels: number }) => void;
  }) => {
    state.streamBuffers.push(options.onBuffer);
    return {
      stream: {
        start: async () => {
          state.streamStartCalls += 1;
        },
        stop: () => undefined,
      },
    };
  },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = `file:///local-asr-${String(parts.length)}.wav`;
    }
    write(_bytes: Uint8Array) {}
    delete() {}
  },
  Directory: class {
    uri = "file:///cache/";
  },
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
    key === "transcribe"
      ? async () => {
          state.remoteCalls += 1;
          return { _tag: "Failure" as const, cause: { _tag: "Fail" } };
        }
      : async () => ({ _tag: "Failure" as const, cause: { _tag: "Fail" } }),
}));
vi.mock("./mobilePcmPlayer", () => ({
  getMobilePcmPlayer: () => ({
    begin: async () => undefined,
    write: async () => undefined,
    end: async () => undefined,
    stop: () => undefined,
  }),
}));
vi.mock("../../native/voiceTranscription", () => ({
  getLocalVoiceTranscriber: () => ({
    prepare: async () => {
      state.prepareCalls += 1;
      return {
        locale: "en-US",
        transcribe: async (uri: unknown) => {
          state.transcribeUris.push(uri);
          return state.localTranscript;
        },
      };
    },
  }),
  getLocalLiveVoiceRecognizer: () => null,
}));

import { useJarvisVoice } from "./useJarvisVoice";

const voiceNodeId = EnvironmentId.make("voice-node");

function renderExplicit(input: {
  nodes: Parameters<typeof useJarvisVoice>[0]["nodes"];
  sttPreference?: "local" | "remote";
}) {
  hooks.beginRender();
  return useJarvisVoice({
    nodes: input.nodes,
    ...(input.sttPreference === undefined ? {} : { sttPreference: input.sttPreference }),
    onMessage: (message: string) => {
      state.messages.push(message);
    },
    onTranscript: async (draft, transcript: string) => {
      state.transcripts.push({
        text: transcript,
        voiceNodeId: (draft as { voiceNodeId?: unknown }).voiceNodeId,
      });
    },
  });
}

function withVoiceNode() {
  return [
    {
      nodeId: voiceNodeId,
      label: "Desk",
      reachability: "online",
      capabilities: { voiceCompute: true } as never,
    },
  ] as Parameters<typeof useJarvisVoice>[0]["nodes"];
}

async function flush(times = 8) {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.messages = [];
  state.transcripts = [];
  state.transcribeUris = [];
  state.remoteCalls = 0;
  state.prepareCalls = 0;
  state.streamStartCalls = 0;
  state.streamBuffers = [];
  state.localTranscript = "local hello";
  state.appActive = true;
});

describe("explicit STT selection", () => {
  it("never auto-uses local when remote is explicitly selected", async () => {
    const voice = renderExplicit({ nodes: withVoiceNode(), sttPreference: "remote" });
    await voice.startCapture({ originInteractionId: "origin-remote" });
    await flush();
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    await voice.finishCapture();
    await flush();
    expect(state.prepareCalls).toBe(0);
    expect(state.remoteCalls).toBe(1);
    expect(state.transcribeUris).toHaveLength(0);
  });

  it("defaults to remote when no explicit choice exists, even with local available", async () => {
    const voice = renderExplicit({ nodes: withVoiceNode() });
    await voice.startCapture({ originInteractionId: "origin-default" });
    await flush();
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    await voice.finishCapture();
    await flush();
    expect(state.prepareCalls).toBe(0);
    expect(state.remoteCalls).toBe(1);
  });

  it("runs local input with no voice node through onTranscript", async () => {
    const voice = renderExplicit({ nodes: [], sttPreference: "local" });
    await voice.startCapture({ originInteractionId: "origin-local-no-node" });
    await flush();
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    await voice.finishCapture();
    await flush();
    expect(state.transcripts).toEqual([{ text: "local hello", voiceNodeId: undefined }]);
    expect(state.remoteCalls).toBe(0);
  });

  it("never passes a fake local-asr URI sentinel to any transcriber", async () => {
    const voice = renderExplicit({ nodes: [], sttPreference: "local" });
    await voice.startCapture({ originInteractionId: "origin-no-sentinel" });
    await flush();
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    await voice.finishCapture();
    await flush();
    for (const uri of state.transcribeUris) {
      expect(String(uri).startsWith("local-asr://")).toBe(false);
    }
    expect(state.transcribeUris.length).toBeGreaterThan(0);
    expect(String(state.transcribeUris[0]).startsWith("file:///")).toBe(true);
  });

  it("keeps TTS gated on the voice node while local STT runs", async () => {
    const voice = renderExplicit({ nodes: [], sttPreference: "local" });
    expect(voice.ttsAvailable).toBe(false);
    voice.enqueueSpeech({
      text: "Hello.",
      nodeId: voiceNodeId,
      speechKey: "presentation-1",
      threadKey: "thread-A",
    });
    await flush();
    expect(state.messages).toEqual([]);
  });
});
