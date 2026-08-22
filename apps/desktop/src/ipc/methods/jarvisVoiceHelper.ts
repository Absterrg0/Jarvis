import { DesktopJarvisVoiceHelperStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopJarvisVoiceHelper from "../../app/DesktopJarvisVoiceHelper.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getJarvisVoiceHelperState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_HELPER_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopJarvisVoiceHelperStateSchema,
  handler: Effect.fn("desktop.ipc.jarvisVoiceHelper.getState")(function* () {
    const helper = yield* DesktopJarvisVoiceHelper.DesktopJarvisVoiceHelperService;
    return helper.getState();
  }),
});

export const ensureJarvisVoiceHelperRunning = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_HELPER_ENSURE_RUNNING_CHANNEL,
  payload: Schema.Struct({ pairingUrl: Schema.optionalKey(Schema.String) }),
  result: DesktopJarvisVoiceHelperStateSchema,
  handler: Effect.fn("desktop.ipc.jarvisVoiceHelper.ensureRunning")(function* ({ pairingUrl }) {
    const helper = yield* DesktopJarvisVoiceHelper.DesktopJarvisVoiceHelperService;
    return yield* Effect.promise(() => helper.ensureRunning(pairingUrl));
  }),
});

export const deliverJarvisVoiceHelperPairingUrl = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JARVIS_VOICE_HELPER_DELIVER_PAIRING_URL_CHANNEL,
  payload: Schema.Struct({ pairingUrl: Schema.String }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.jarvisVoiceHelper.deliverPairingUrl")(function* ({ pairingUrl }) {
    const helper = yield* DesktopJarvisVoiceHelper.DesktopJarvisVoiceHelperService;
    return yield* Effect.promise(() => helper.deliverPairingUrl(pairingUrl));
  }),
});
