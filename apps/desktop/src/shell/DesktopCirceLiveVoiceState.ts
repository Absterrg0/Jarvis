import {
  DesktopCirceLiveVoiceStateSchema,
  type DesktopCirceLiveVoiceState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CIRCE_LIVE_VOICE_STATE_CHANNEL } from "../ipc/channels.ts";

const decodeState = Schema.decodeUnknownOption(DesktopCirceLiveVoiceStateSchema);

export interface DesktopCirceLiveVoiceIpcMain {
  on(channel: string, listener: (event: unknown, raw: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, raw: unknown) => void): void;
}

export interface DesktopCirceLiveVoiceStateBridge {
  /** Latest reported state, or null before the renderer has reported once. */
  readonly getState: () => DesktopCirceLiveVoiceState | null;
  readonly onState: (listener: (state: DesktopCirceLiveVoiceState) => void) => () => void;
  readonly dispose: () => void;
}

/**
 * The renderer owns the live conversation, so the main process learns its
 * state through a one-way report. Invalid or missing reports leave the last
 * known state alone; the tray and shortcut never invent session state.
 */
export function createDesktopCirceLiveVoiceStateBridge(
  ipcMain: DesktopCirceLiveVoiceIpcMain,
): DesktopCirceLiveVoiceStateBridge {
  let state: DesktopCirceLiveVoiceState | null = null;
  const listeners = new Set<(value: DesktopCirceLiveVoiceState) => void>();

  const onReport = (_event: unknown, raw: unknown) => {
    const decoded = decodeState(raw);
    if (Option.isNone(decoded)) return;
    state = decoded.value;
    for (const listener of listeners) listener(decoded.value);
  };

  ipcMain.on(CIRCE_LIVE_VOICE_STATE_CHANNEL, onReport);

  return {
    getState: () => state,
    onState: (listener) => {
      listeners.add(listener);
      if (state !== null) listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      listeners.clear();
      state = null;
      ipcMain.removeListener(CIRCE_LIVE_VOICE_STATE_CHANNEL, onReport);
    },
  };
}
