import { DesktopJarvisVoiceStateSchema, type DesktopJarvisVoiceState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopJarvisVoice from "../../voice/DesktopJarvisVoice.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const accepted = Schema.Struct({ accepted: Schema.Boolean });

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

export const startJarvisVoiceCapture = action(
  IpcChannels.JARVIS_VOICE_CAPTURE_START_CHANNEL,
  "desktop.ipc.jarvisVoice.startCapture",
  (voice) => voice.startCapture(),
);
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
  payload: Schema.Struct({ text: Schema.String }),
  result: accepted,
  handler: Effect.fn("desktop.ipc.jarvisVoice.speak")(function* ({ text }) {
    const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
    return yield* Effect.promise(() => voice.speak(text));
  }),
});

export type JarvisVoiceState = DesktopJarvisVoiceState;
