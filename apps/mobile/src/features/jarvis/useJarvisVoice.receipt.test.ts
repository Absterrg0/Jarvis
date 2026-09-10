/**
 * Receipt feedback at mobile capture release.
 *
 * Proven here: a local haptic fires synchronously from finishCapture before
 * remote transcription starts, cancel fires none, an empty remote result
 * reports instead of submitting silence, and a missing haptics module still
 * transcribes. No microphone, recognizer, or network runs, and no audio
 * playback is asserted as proof.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";

const state = vi.hoisted(() => ({
  messages: [] as string[],
  transcripts: [] as string[],
  order: [] as string[],
  remoteTranscript: "open rivvl",
  hapticsShouldThrow: false,
  streamBuffers: [] as Array<
    (buffer: { data: ArrayBuffer; sampleRate: number; channels: number }) => void
  >,
  appActive: true,
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
    return { stream: { start: async () => undefined, stop: () => undefined } };
  },
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
  impactAsync: async () => {
    if (state.hapticsShouldThrow) throw new Error("haptics missing");
    state.order.push("receipt");
  },
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
  useAbortableAtomCommand: (key: string) => {
    if (key === "transcribe") {
      return async () => {
        state.order.push("transcribe");
        return { _tag: "Success" as const, value: { text: state.remoteTranscript } };
      };
    }
    return async () => {
      state.order.push("stream");
      return { _tag: "Failure" as const, cause: { _tag: "Fail" } };
    };
  },
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
  getLocalVoiceTranscriber: () => null,
  getLocalLiveVoiceRecognizer: () => null,
}));

import { useJarvisVoice } from "./useJarvisVoice";

const voiceNodeId = EnvironmentId.make("voice-node");

function renderRemote() {
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
    sttPreference: "remote",
    onMessage: (message: string) => {
      state.messages.push(message);
    },
    onTranscript: async (_turn, transcript: string) => {
      state.order.push("transcript");
      state.transcripts.push(transcript);
    },
  });
}

async function flush(times = 10) {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.messages = [];
  state.transcripts = [];
  state.order = [];
  state.remoteTranscript = "open rivvl";
  state.hapticsShouldThrow = false;
  state.streamBuffers = [];
  state.appActive = true;
});

describe("mobile capture receipt", () => {
  it("fires the receipt at release before remote transcription", async () => {
    const voice = renderRemote();
    await voice.startCapture({ originInteractionId: "origin-receipt" });
    await flush();
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    state.order = [];
    await voice.finishCapture();
    await flush();
    // Local receipt only: no remote synthesis for the cue itself.
    expect(state.order).toEqual(["receipt", "transcribe", "transcript"]);
    expect(state.order).not.toContain("stream");
    expect(state.transcripts).toEqual(["open rivvl"]);
  });

  it("never fires the receipt on cancel", async () => {
    const voice = renderRemote();
    await voice.startCapture({ originInteractionId: "origin-cancel" });
    await flush();
    state.order = [];
    voice.cancelCapture();
    await flush();
    expect(state.order).toEqual([]);
    expect(state.transcripts).toEqual([]);
  });

  it("reports an empty remote result instead of submitting silence", async () => {
    state.remoteTranscript = "   ";
    const voice = renderRemote();
    await voice.startCapture({ originInteractionId: "origin-empty" });
    await flush();
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    state.order = [];
    await voice.finishCapture();
    await flush();
    expect(state.order).toEqual(["receipt", "transcribe"]);
    expect(state.transcripts).toEqual([]);
    expect(state.messages).toContain("No speech was detected.");
  });

  it("still transcribes when the receipt player is missing", async () => {
    state.hapticsShouldThrow = true;
    const voice = renderRemote();
    await voice.startCapture({ originInteractionId: "origin-no-haptics" });
    await flush();
    state.streamBuffers.at(-1)?.(pcmBuffer([1, 0, 2, 0]));
    state.order = [];
    await voice.finishCapture();
    await flush();
    // No receipt recorded, but transcription still lands: UI never depends
    // on audio availability.
    expect(state.order).toEqual(["transcribe", "transcript"]);
    expect(state.transcripts).toEqual(["open rivvl"]);
  });
});
