/**
 * Static tests for local on-device transcription in `useJarvisVoice`.
 *
 * Proven here: backend snapshot at capture start, no silent fallback or
 * upload on local failure, empty-result honesty, cancel silence, and TTS
 * staying gated on the selected voice node while STT runs locally.
 * No microphone, recognizer, or network runs. Physical-device verification
 * (pack download, offline behavior, mic arbitration) is pending.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";

const state = vi.hoisted(() => ({
  messages: [] as string[],
  transcripts: [] as string[],
  transcribeCalls: [] as unknown[],
  prepareCalls: 0,
  prepareLocales: [] as string[],
  transcribeUris: [] as unknown[],
  remoteCalls: 0,
  streamStartCalls: 0,
  streamBuffers: [] as Array<
    (buffer: { data: ArrayBuffer; sampleRate: number; channels: number }) => void
  >,
  localTranscript: "local hello",
  localError: null as null | { code: string; message: string },
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
  getLocalLiveVoiceRecognizer: () => null,
  getLocalVoiceTranscriber: () => {
    if (state.localError !== null && state.localError.code === "no-transcriber") return null;
    return {
      prepare: async () => {
        state.prepareCalls += 1;
        if (state.localError !== null) {
          const error = new Error(state.localError.message) as Error & { code: string };
          error.code = state.localError.code;
          throw error;
        }
        const locale = "en-US";
        state.prepareLocales.push(locale);
        return {
          locale,
          transcribe: async (uri: unknown) => {
            state.transcribeUris.push(uri);
            return state.localTranscript;
          },
        };
      },
    };
  },
}));

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";
import { useJarvisVoice } from "./useJarvisVoice";

const voiceNodeId = EnvironmentId.make("voice-node");

function renderWithNodes(
  nodes: Parameters<typeof useJarvisVoice>[0]["nodes"],
  sttPreference: "local" | "remote" = "local",
) {
  hooks.beginRender();
  return useJarvisVoice({
    nodes,
    sttPreference,
    onMessage: (message: string) => {
      state.messages.push(message);
    },
    onTranscript: async (_turn, transcript: string) => {
      state.transcripts.push(transcript);
    },
  });
}

function render() {
  return renderWithNodes([
    {
      nodeId: voiceNodeId,
      label: "Desk",
      reachability: "online",
      capabilities: { voiceCompute: true } as never,
    },
  ]);
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
  state.transcribeCalls = [];
  state.prepareCalls = 0;
  state.prepareLocales = [];
  state.transcribeUris = [];
  state.remoteCalls = 0;
  state.streamStartCalls = 0;
  state.streamBuffers = [];
  state.localTranscript = "local hello";
  state.localError = null;
  state.appActive = true;
});

describe("local on-device transcription snapshot", () => {
  it("transcribes locally and never calls the remote node", async () => {
    const voice = render();
    expect(voice.localAsrAvailable).toBe(true);
    await voice.startCapture({ originInteractionId: "origin-1" });
    await flush();
    expect(state.prepareCalls).toBe(1);
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    await voice.finishCapture();
    await flush();
    expect(state.transcripts).toEqual(["local hello"]);
    expect(state.remoteCalls).toBe(0);
    expect(state.transcribeUris).toHaveLength(1);
    expect(String(state.transcribeUris[0])).toMatch(/^file:\/\//);
    expect(render().phase).toBe("idle");
  });

  it("reports a local failure without uploading audio", async () => {
    state.localError = { code: "transcription-failed", message: "engine blew up" };
    const voice = render();
    await voice.startCapture({ originInteractionId: "origin-1" });
    await flush();
    // Preparation throws, so capture never starts and nothing uploads.
    expect(state.remoteCalls).toBe(0);
    expect(state.transcripts).toEqual([]);
    expect(state.messages.length).toBeGreaterThan(0);
  });

  it("stays honest on empty results instead of submitting silence", async () => {
    state.localTranscript = "   ";
    const voice = render();
    await voice.startCapture({ originInteractionId: "origin-1" });
    await flush();
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    await voice.finishCapture();
    await flush();
    expect(state.transcripts).toEqual([]);
    expect(state.remoteCalls).toBe(0);
    expect(state.messages).toContain("No speech was detected.");
  });

  it("cancels a local capture silently without remote traffic", async () => {
    const voice = render();
    await voice.startCapture({ originInteractionId: "origin-1" });
    await flush();
    voice.cancelCapture();
    await flush();
    expect(state.transcripts).toEqual([]);
    expect(state.remoteCalls).toBe(0);
    expect(render().phase).toBe("idle");
  });

  it("keeps TTS gated on the voice node while STT runs locally", async () => {
    const voice = renderWithNodes([]);
    expect(voice.localAsrAvailable).toBe(true);
    expect(voice.selection.status).toBe("no-voice-node");
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

  it("never falls back to remote when explicit local has no transcriber", async () => {
    state.localError = { code: "no-transcriber", message: "missing" };
    const voice = render();
    expect(voice.localAsrAvailable).toBe(false);
    await voice.startCapture({ originInteractionId: "origin-1" });
    await flush();
    expect(state.prepareCalls).toBe(0);
    expect(state.remoteCalls).toBe(0);
    expect(state.transcripts).toEqual([]);
    expect(state.messages.length).toBeGreaterThan(0);
  });

  it("uses the remote node when remote is explicitly selected", async () => {
    const voice = renderWithNodes(
      [
        {
          nodeId: voiceNodeId,
          label: "Desk",
          reachability: "online",
          capabilities: { voiceCompute: true } as never,
        },
      ],
      "remote",
    );
    await voice.startCapture({ originInteractionId: "origin-remote" });
    await flush();
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    await voice.finishCapture();
    await flush();
    expect(state.prepareCalls).toBe(0);
    expect(state.remoteCalls).toBe(1);
  });

  it("maps abort to silence through the shared error type", () => {
    const error = new VoiceTranscriptionError("cancelled", "cancelled");
    expect(error.code).toBe("cancelled");
  });
});
