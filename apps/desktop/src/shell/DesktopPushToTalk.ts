/**
 * The native hook is deliberately isolated from Electron. Electron's
 * `globalShortcut` exposes activation but not key release, while push-to-talk
 * needs both edges. This module only understands Ctrl+Shift+J and never
 * stores or reports any other keyboard input.
 */
export const desktopPushToTalkKeys = {
  control: 29,
  controlRight: 3613,
  shift: 42,
  shiftRight: 54,
  j: 36,
} as const;

export type DesktopPushToTalkKeyEvent = {
  readonly keycode: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
};

export type DesktopPushToTalkState = { readonly active: boolean };
export type DesktopPushToTalkAction = "pressed" | "released" | undefined;

const releaseKeys = new Set<number>([
  desktopPushToTalkKeys.control,
  desktopPushToTalkKeys.controlRight,
  desktopPushToTalkKeys.shift,
  desktopPushToTalkKeys.shiftRight,
]);

/** Reduces only Ctrl+Shift+J events into the two capture edges. */
export function transitionDesktopPushToTalk(
  state: DesktopPushToTalkState,
  type: "keydown" | "keyup",
  event: DesktopPushToTalkKeyEvent,
  options?: { readonly releaseOnJ?: boolean },
): { readonly state: DesktopPushToTalkState; readonly action: DesktopPushToTalkAction } {
  if (
    type === "keydown" &&
    !state.active &&
    event.keycode === desktopPushToTalkKeys.j &&
    event.ctrlKey &&
    event.shiftKey
  ) {
    return { state: { active: true }, action: "pressed" };
  }
  // uiohook emits a synthetic J key-up after every auto-repeat key-down on
  // GNOME. Releasing capture on J therefore turns one physical hold into a
  // rapid start/stop loop. Modifier keys do not auto-repeat, so one of their
  // key-up edges is the reliable end of this three-key chord.
  const isReleaseKey =
    releaseKeys.has(event.keycode) ||
    (options?.releaseOnJ === true && event.keycode === desktopPushToTalkKeys.j);
  if (type === "keyup" && state.active && isReleaseKey) {
    return { state: { active: false }, action: "released" };
  }
  return { state, action: undefined };
}

export type DesktopPushToTalkHook = {
  on: (type: "keydown" | "keyup", listener: (event: DesktopPushToTalkKeyEvent) => void) => unknown;
  removeListener: (
    type: "keydown" | "keyup",
    listener: (event: DesktopPushToTalkKeyEvent) => void,
  ) => unknown;
  start: () => void;
  stop: () => void;
};

/**
 * Starts a privacy-minimal hook adapter. The hook events themselves never
 * leave this boundary; the consumer receives only a start/release signal.
 */
export function attachDesktopPushToTalkHook(input: {
  readonly hook: DesktopPushToTalkHook;
  readonly onPressed: () => void;
  readonly onReleased: () => void;
  /** Windows has a real J key-up; Linux ignores it because GNOME synthesizes it during repeat. */
  readonly releaseOnJ?: boolean;
}): () => void {
  let state: DesktopPushToTalkState = { active: false };
  let detached = false;
  const update = (type: "keydown" | "keyup") => (event: DesktopPushToTalkKeyEvent) => {
    if (detached) return;
    const next = transitionDesktopPushToTalk(state, type, event, {
      releaseOnJ: input.releaseOnJ === true,
    });
    state = next.state;
    if (next.action === "pressed") input.onPressed();
    if (next.action === "released") input.onReleased();
  };
  const onKeyDown = update("keydown");
  const onKeyUp = update("keyup");
  let keyDownRegistered = false;
  let keyUpRegistered = false;
  try {
    input.hook.on("keydown", onKeyDown);
    keyDownRegistered = true;
    input.hook.on("keyup", onKeyUp);
    keyUpRegistered = true;
    input.hook.start();
  } catch (error) {
    detached = true;
    if (keyDownRegistered) input.hook.removeListener("keydown", onKeyDown);
    if (keyUpRegistered) input.hook.removeListener("keyup", onKeyUp);
    input.hook.stop();
    throw error;
  }

  return () => {
    if (detached) return;
    detached = true;
    input.hook.removeListener("keydown", onKeyDown);
    input.hook.removeListener("keyup", onKeyUp);
    input.hook.stop();
    if (state.active) {
      state = { active: false };
      input.onReleased();
    }
  };
}
