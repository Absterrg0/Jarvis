/**
 * Negative regression test: cancellation holds the local temp file until the
 * native transcribe settles instead of deleting it mid-read.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";

const state = vi.hoisted(() => ({
  messages: [] as string[],
  transcripts: [] as string[],
  deletes: 0,
  enteredTranscribe: [] as Array<() => void>,
  finishTranscribe: [] as Array<(value: string) => void>,
  streamBuffers: [] as Array<
    (buffer: { data: ArrayBuffer; sampleRate: number; channels: number }) => void
  >,
}));

function pcmBuffer(bytes: number[]): { data: ArrayBuffer; sampleRate: number; channels: number } {
  return { data: new Uint8Array(bytes).buffer as ArrayBuffer, sampleRate: 16_000, channels: 1 };
}

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { ...actual, ...reactHookHarness, useEffect: () => undefined };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "test-uuid" }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
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
    return { stream: { start: async () => undefined, stop: () => undefined } };
  },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    uri = "file:///local-asr-held.wav";
    write(_bytes: Uint8Array) {}
    delete() {
      state.deletes += 1;
    }
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
  useAtomValue: () => ({ _tag: "Success", value: { preferredVoiceStt: "local" } }),
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
  useAbortableAtomCommand: () => async () => ({ _tag: "Failure", cause: { _tag: "Fail" } }),
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
    prepare: async () => ({
      locale: "en-US",
      transcribe: async (_uri: unknown, options?: { signal: AbortSignal }) =>
        new Promise<string>((resolve, reject) => {
          state.enteredTranscribe.push(() => undefined);
          const finish = (value: string) => resolve(value);
          state.finishTranscribe.push(finish);
          options?.signal.addEventListener("abort", () => {
            // Native work keeps running until it settles; the adapter maps the
            // late abort to cancellation only after the native promise ends.
          });
        }),
    }),
  }),
  getLocalLiveVoiceRecognizer: () => null,
}));

import { useJarvisVoice } from "./useJarvisVoice";

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
  state.deletes = 0;
  state.enteredTranscribe = [];
  state.finishTranscribe = [];
  state.streamBuffers = [];
});

describe("local cancellation holds resources", () => {
  it("keeps the temp file until the native transcribe settles", async () => {
    const { EnvironmentId } = await import("@t3tools/contracts");
    const voiceNodeId = EnvironmentId.make("voice-node");
    hooks.beginRender();
    const voice = useJarvisVoice({
      nodes: [
        {
          nodeId: voiceNodeId,
          label: "Desk",
          reachability: "online",
          capabilities: { voiceCompute: true } as never,
        },
      ],
      sttPreference: "local",
      onMessage: (message: string) => {
        state.messages.push(message);
      },
      onTranscript: async (_turn, transcript: string) => {
        state.transcripts.push(transcript);
      },
    });
    await voice.startCapture({ originInteractionId: "origin-hold" });
    await flush();
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    const finishing = voice.finishCapture();
    await vi.waitFor(() => expect(state.enteredTranscribe).toHaveLength(1));
    voice.cancelCapture();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Cancel aborts the signal but must not delete the file mid-read.
    expect(state.deletes).toBe(0);
    expect(state.transcripts).toEqual([]);
    state.finishTranscribe[0]?.("late hello");
    await finishing;
    await flush();
    expect(state.deletes).toBeGreaterThan(0);
    expect(state.transcripts).toEqual([]);
  });
});
