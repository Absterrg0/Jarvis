/**
 * The native hook is deliberately isolated from Electron. Electron's
 * `globalShortcut` exposes activation but not key release, while push-to-talk
 * needs both edges. This module only understands the three keys we need and
 * never stores or reports any other keyboard input.
 */
export const pushToTalkKeys = {
  control: 29,
  controlRight: 3613,
  shift: 42,
  shiftRight: 54,
  j: 36,
} as const;

export type PushToTalkKeyEvent = {
  readonly keycode: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
};

export type PushToTalkState = { readonly active: boolean };

export type PushToTalkAction = "pressed" | "released" | undefined;

const releaseKeys = new Set<number>([
  pushToTalkKeys.control,
  pushToTalkKeys.controlRight,
  pushToTalkKeys.shift,
  pushToTalkKeys.shiftRight,
  pushToTalkKeys.j,
]);

/** Reduces only Ctrl+Shift+J events into the two capture edges. */
export function transitionPushToTalk(
  state: PushToTalkState,
  type: "keydown" | "keyup",
  event: PushToTalkKeyEvent,
): { readonly state: PushToTalkState; readonly action: PushToTalkAction } {
  if (
    type === "keydown" &&
    !state.active &&
    event.keycode === pushToTalkKeys.j &&
    event.ctrlKey &&
    event.shiftKey
  ) {
    return { state: { active: true }, action: "pressed" };
  }
  if (type === "keyup" && state.active && releaseKeys.has(event.keycode)) {
    return { state: { active: false }, action: "released" };
  }
  return { state, action: undefined };
}

export type PushToTalkHook = {
  on: (type: "keydown" | "keyup", listener: (event: PushToTalkKeyEvent) => void) => unknown;
  removeListener: (
    type: "keydown" | "keyup",
    listener: (event: PushToTalkKeyEvent) => void,
  ) => unknown;
  start: () => void;
  stop: () => void;
};

/**
 * Starts a privacy-minimal hook adapter. The hook events themselves never
 * leave this boundary; the consumer receives only a start/release signal.
 */
export function attachPushToTalkHook(input: {
  readonly hook: PushToTalkHook;
  readonly onPressed: () => void;
  readonly onReleased: () => void;
}): () => void {
  let state: PushToTalkState = { active: false };
  const update = (type: "keydown" | "keyup") => (event: PushToTalkKeyEvent) => {
    const next = transitionPushToTalk(state, type, event);
    state = next.state;
    if (next.action === "pressed") input.onPressed();
    if (next.action === "released") input.onReleased();
  };
  const onKeyDown = update("keydown");
  const onKeyUp = update("keyup");
  input.hook.on("keydown", onKeyDown);
  input.hook.on("keyup", onKeyUp);
  input.hook.start();

  return () => {
    input.hook.removeListener("keydown", onKeyDown);
    input.hook.removeListener("keyup", onKeyUp);
    input.hook.stop();
    if (state.active) input.onReleased();
  };
}
