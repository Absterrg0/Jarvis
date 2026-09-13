import type { DesktopUseAction, DesktopUseDisplay, DesktopUseModifier } from "@t3tools/contracts";

/**
 * Safety limits for an agent driving a real desktop. These are intentionally
 * generous enough for any normal UI, and hard enough to stop a runaway model
 * from clicking off-screen forever or holding a modifier down.
 */

export const DESKTOP_USE_MAX_COORDINATE = 100_000;
export const DESKTOP_USE_MAX_TEXT_LENGTH = 4_096;
export const DESKTOP_USE_MAX_SCROLL_DELTA = 100_000;
export const DESKTOP_USE_MAX_DRAG_DURATION_MS = 60_000;
export const DESKTOP_USE_MIN_ACTION_INTERVAL_MS = 8;

const NAMED_KEYS = new Set([
  "enter",
  "return",
  "esc",
  "escape",
  "tab",
  "space",
  "backspace",
  "delete",
  "del",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "up",
  "down",
  "left",
  "right",
  "capslock",
  "shift",
  "control",
  "ctrl",
  "alt",
  "meta",
  "super",
  "win",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

/** A single keystroke is either a named key or one printable character. */
export const isAllowedKey = (key: string): boolean => {
  if (NAMED_KEYS.has(key.toLowerCase())) return true;
  return [...key].length === 1 && key.charCodeAt(0) >= 0x20;
};

const inBounds = (value: number): boolean =>
  Number.isFinite(value) && Math.abs(value) <= DESKTOP_USE_MAX_COORDINATE;

/**
 * Returns a refusal reason, or null when the action is acceptable. This does
 * not consult display geometry: an action may target a coordinate that is
 * off-screen, which is a normal scroll/overshoot pattern and not an attack.
 */
export function validateDesktopUseAction(action: DesktopUseAction): string | null {
  switch (action.type) {
    case "pointer.move":
      return inBounds(action.x) && inBounds(action.y)
        ? null
        : "Pointer coordinates are out of range.";
    case "pointer.click":
      return (action.x === undefined || inBounds(action.x)) &&
        (action.y === undefined || inBounds(action.y))
        ? null
        : "Pointer coordinates are out of range.";
    case "pointer.down":
    case "pointer.up":
      return null;
    case "pointer.drag":
      return inBounds(action.from.x) &&
        inBounds(action.from.y) &&
        inBounds(action.to.x) &&
        inBounds(action.to.y) &&
        (action.durationMs === undefined ||
          (action.durationMs >= 0 && action.durationMs <= DESKTOP_USE_MAX_DRAG_DURATION_MS))
        ? null
        : "Drag is out of range.";
    case "pointer.scroll": {
      const deltaX = action.deltaX ?? 0;
      const deltaY = action.deltaY ?? 0;
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        return "Scroll delta is not a number.";
      }
      if (
        Math.abs(deltaX) > DESKTOP_USE_MAX_SCROLL_DELTA ||
        Math.abs(deltaY) > DESKTOP_USE_MAX_SCROLL_DELTA
      ) {
        return "Scroll delta is out of range.";
      }
      if (deltaX === 0 && deltaY === 0) return "Scroll requires deltaX or deltaY.";
      return null;
    }
    case "keyboard.type":
      return action.text.length <= DESKTOP_USE_MAX_TEXT_LENGTH ? null : "Typed text is too long.";
    case "keyboard.key": {
      if (!isAllowedKey(action.key)) return `Key ${action.key} is not allowed.`;
      for (const modifier of action.modifiers ?? []) {
        if (!["alt", "control", "meta", "shift"].includes(modifier)) {
          return `Modifier ${modifier} is not allowed.`;
        }
      }
      return null;
    }
    case "window.focus":
      return null;
  }
}

export interface DesktopUseRateLimitState {
  readonly lastActionAt: number;
}

/**
 * Enforces a floor between injected actions so a model cannot flood the event
 * queue. Returns the next state, or a refusal reason when called too soon.
 */
export function checkRateLimit(
  state: DesktopUseRateLimitState,
  now: number,
): { readonly next: DesktopUseRateLimitState; readonly reason: string | null } {
  if (state.lastActionAt > 0 && now - state.lastActionAt < DESKTOP_USE_MIN_ACTION_INTERVAL_MS) {
    return { next: state, reason: "Actions are arriving faster than the desktop can accept." };
  }
  return { next: { lastActionAt: now }, reason: null };
}

/** The display an action's coordinates refer to, defaulting to the primary display. */
export function resolveDisplay(
  displays: ReadonlyArray<DesktopUseDisplay>,
  displayId: string | undefined,
): DesktopUseDisplay | undefined {
  if (displayId !== undefined) {
    return displays.find((display) => display.id === displayId);
  }
  return displays.find((display) => display.primary) ?? displays[0];
}

export const isModifier = (value: string): value is DesktopUseModifier =>
  value === "alt" || value === "control" || value === "meta" || value === "shift";
