// oxlint-disable t3code/no-global-process-runtime -- Electron IPC owns native microphone permissions.
import {
  DesktopJarvisVoiceSpeechLane,
  DesktopJarvisVoiceStateSchema,
  type DesktopJarvisVoiceState,
} from "@t3tools/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopJarvisVoice from "../../voice/DesktopJarvisVoice.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const accepted = Schema.Struct({ accepted: Schema.Boolean });
const captureSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("native") }),
  Schema.Struct({
    type: Schema.Literal("renderer-pcm"),
    sessionId: Schema.String,
    generation: Schema.Int,
    sampleRate: Schema.Number,
    channels: Schema.Int,
  }),
]);
const captureStartOptions = Schema.Struct({
  purpose: Schema.optionalKey(Schema.Literals(["command", "diagnostic"])),
  captureId: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(captureSource),
  contextualPhrases: Schema.optionalKey(Schema.Array(Schema.String)),
});
const captureStartPayload = Schema.Union([Schema.Void, captureSource, captureStartOptions]);
const pcmFrame = Schema.Struct({
  sessionId: Schema.String,
  generation: Schema.Int,
  samples: Schema.declare<Float32Array>(
    (value): value is Float32Array => value instanceof Float32Array,
  ),
});

export const getJarvisVoiceState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopJarvisVoiceStateSchema,
  handler: Effect.fn("desktop.ipc.jarvisVoice.getState")(function* () {
    const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
    return voice.getState();
  }),
});

export const prepareJarvisVoice = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_PREPARE_CHANNEL,
  payload: Schema.Void,
  result: DesktopJarvisVoiceStateSchema,
  handler: Effect.fn("desktop.ipc.jarvisVoice.prepare")(function* () {
    const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
    return yield* Effect.promise(voice.prepare);
  }),
});

export const prepareJarvisSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_PREPARE_SPEECH_CHANNEL,
  payload: Schema.Void,
  result: accepted,
  handler: Effect.fn("desktop.ipc.jarvisVoice.prepareSpeech")(function* () {
    const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
    return yield* Effect.promise(voice.prepareSpeech);
  }),
});

export const playJarvisAcknowledgement = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_PLAY_ACKNOWLEDGEMENT_CHANNEL,
  payload: Schema.Void,
  result: accepted,
  handler: Effect.fn("desktop.ipc.jarvisVoice.playAcknowledgement")(function* () {
    const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
    return yield* Effect.promise(voice.playAcknowledgement);
  }),
});

const action = (
  channel: string,
  name: string,
  run: (voice: DesktopJarvisVoice.DesktopJarvisVoice) => Promise<{ readonly accepted: boolean }>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: Schema.Void,
    result: accepted,
    handler: Effect.fn(name)(function* () {
      const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
      return yield* Effect.promise(() => run(voice));
    }),
  });

export const startJarvisVoiceCapture = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_CAPTURE_START_CHANNEL,
  payload: captureStartPayload,
  result: accepted,
  handler: Effect.fn("desktop.ipc.jarvisVoice.startCapture")(function* (source) {
    const normalizedSource =
      typeof source === "object" && source !== null && "type" in source && source.type !== undefined
        ? source
        : typeof source === "object" && source !== null
          ? source
          : undefined;
    const rendererSource =
      normalizedSource !== undefined &&
      "type" in normalizedSource &&
      normalizedSource.type === "renderer-pcm"
        ? normalizedSource
        : normalizedSource !== undefined &&
            "source" in normalizedSource &&
            normalizedSource.source?.type === "renderer-pcm"
          ? normalizedSource.source
          : undefined;
    if (rendererSource !== undefined && process.platform === "darwin") {
      const allowed = yield* Effect.promise(() => ensureMacMicrophonePermission());
      if (!allowed) return { accepted: false };
    }
    const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
    return yield* Effect.promise(() =>
      voice.startCapture(typeof source === "object" && source !== null ? source : undefined),
    );
  }),
});

export async function ensureMacMicrophonePermission(
  systemPreferences: Pick<
    typeof Electron.systemPreferences,
    "getMediaAccessStatus" | "askForMediaAccess"
  > = Electron.systemPreferences,
): Promise<boolean> {
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (status !== "not-determined") return false;
  return systemPreferences.askForMediaAccess("microphone");
}

export const preflightJarvisVoiceMicrophone = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_CAPTURE_PERMISSION_CHANNEL,
  payload: Schema.Void,
  result: accepted,
  handler: Effect.fn("desktop.ipc.jarvisVoice.preflightMicrophone")(function* () {
    if (process.platform !== "darwin") return { accepted: true };
    return { accepted: yield* Effect.promise(() => ensureMacMicrophonePermission()) };
  }),
});
export const pushJarvisVoicePcmFrame = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_CAPTURE_PUSH_PCM_FRAME_CHANNEL,
  payload: pcmFrame,
  result: accepted,
  handler: Effect.fn("desktop.ipc.jarvisVoice.pushPcmFrame")(function* (frame) {
    const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
    return yield* Effect.promise(() => voice.pushPcmFrame(frame));
  }),
});
export const releaseJarvisVoiceCapture = action(
  IpcChannels.JARVIS_VOICE_CAPTURE_RELEASE_CHANNEL,
  "desktop.ipc.jarvisVoice.releaseCapture",
  (voice) => voice.releaseCapture(),
);
export const cancelJarvisVoiceCapture = action(
  IpcChannels.JARVIS_VOICE_CAPTURE_CANCEL_CHANNEL,
  "desktop.ipc.jarvisVoice.cancelCapture",
  (voice) => voice.cancelCapture(),
);
export const interruptJarvisVoice = action(
  IpcChannels.JARVIS_VOICE_INTERRUPT_CHANNEL,
  "desktop.ipc.jarvisVoice.interrupt",
  (voice) => voice.interrupt(),
);

export const speakJarvisVoice = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_SPEAK_CHANNEL,
  payload: Schema.Struct({
    text: Schema.String,
    lane: Schema.optionalKey(DesktopJarvisVoiceSpeechLane),
    deliveryId: Schema.optionalKey(Schema.String),
  }),
  result: Schema.Union([
    Schema.Struct({ status: Schema.Literal("played") }),
    Schema.Struct({ status: Schema.Literal("deferred"), reason: Schema.String }),
    Schema.Struct({ status: Schema.Literal("failed"), code: Schema.String }),
  ]),
  handler: Effect.fn("desktop.ipc.jarvisVoice.speak")(function* ({ text, lane, deliveryId }) {
    const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
    return yield* Effect.promise(() => voice.speak(text, lane, deliveryId));
  }),
});

export const cancelJarvisVoiceSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_CANCEL_SPEECH_CHANNEL,
  payload: Schema.Struct({ deliveryId: Schema.String }),
  result: accepted,
  handler: Effect.fn("desktop.ipc.jarvisVoice.cancelSpeech")(function* ({ deliveryId }) {
    const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
    return yield* Effect.promise(() => voice.cancelSpeech(deliveryId));
  }),
});

export type JarvisVoiceState = DesktopJarvisVoiceState;
