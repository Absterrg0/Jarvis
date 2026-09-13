import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Desktop use is the in-house computer-control capability. One node drives its
 * own physical desktop: capture a display and inject pointer and keyboard
 * events. Nothing here describes a cloud VM — the driver only ever touches the
 * machine the server process runs on.
 */

export const DesktopUsePlatform = Schema.Literals(["darwin", "linux", "win32", "unsupported"]);
export type DesktopUsePlatform = typeof DesktopUsePlatform.Type;

export const DesktopUseBackend = Schema.Literals([
  "macos",
  "linux-x11",
  "linux-wayland",
  "windows",
  "unavailable",
]);
export type DesktopUseBackend = typeof DesktopUseBackend.Type;

const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const BoundedText = Schema.String.check(Schema.isMaxLength(4_096));

export const DesktopUseDisplay = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Device pixel ratio: physical pixels per logical pixel. */
  scale: PositiveFinite,
  primary: Schema.Boolean,
});
export type DesktopUseDisplay = typeof DesktopUseDisplay.Type;

export const DesktopUseStatus = Schema.Struct({
  available: Schema.Boolean,
  platform: DesktopUsePlatform,
  backend: DesktopUseBackend,
  /** Present when unavailable: why this node cannot drive its desktop. */
  reason: Schema.optional(TrimmedNonEmptyString),
  displays: Schema.Array(DesktopUseDisplay),
  supports: Schema.Struct({
    capture: Schema.Boolean,
    pointer: Schema.Boolean,
    keyboard: Schema.Boolean,
    windows: Schema.Boolean,
  }),
});
export type DesktopUseStatus = typeof DesktopUseStatus.Type;

export const DesktopUseCursor = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type DesktopUseCursor = typeof DesktopUseCursor.Type;

/** PNGs are normalized to the display’s native pointer grid (scale 1). Input and cursor coordinates use this grid, relative to the selected display. */
export const DesktopUseFrame = Schema.Struct({
  displayId: TrimmedNonEmptyString,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  scale: PositiveFinite,
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  capturedAt: Schema.Number,
  cursor: Schema.optional(DesktopUseCursor),
});
export type DesktopUseFrame = typeof DesktopUseFrame.Type;

export const DesktopUseMouseButton = Schema.Literals(["left", "middle", "right"]);
export type DesktopUseMouseButton = typeof DesktopUseMouseButton.Type;

export const DesktopUseModifier = Schema.Literals(["alt", "control", "meta", "shift"]);
export type DesktopUseModifier = typeof DesktopUseModifier.Type;

export const DesktopUsePoint = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type DesktopUsePoint = typeof DesktopUsePoint.Type;

const PointerMove = Schema.Struct({
  type: Schema.Literal("pointer.move"),
  x: Schema.Finite,
  y: Schema.Finite,
  durationMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const PointerClick = Schema.Struct({
  type: Schema.Literal("pointer.click"),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  button: Schema.optional(DesktopUseMouseButton),
  count: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(3)),
  ),
});

const PointerDrag = Schema.Struct({
  type: Schema.Literal("pointer.drag"),
  from: DesktopUsePoint,
  to: DesktopUsePoint,
  button: Schema.optional(DesktopUseMouseButton),
  durationMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const PointerScroll = Schema.Struct({
  type: Schema.Literal("pointer.scroll"),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
});

const KeyboardType = Schema.Struct({
  type: Schema.Literal("keyboard.type"),
  text: BoundedText,
});

const KeyboardKey = Schema.Struct({
  type: Schema.Literal("keyboard.key"),
  key: TrimmedNonEmptyString,
  modifiers: Schema.optional(Schema.Array(DesktopUseModifier)),
});

const WindowFocus = Schema.Struct({
  type: Schema.Literal("window.focus"),
  windowId: TrimmedNonEmptyString,
});

export const DesktopUseAction = Schema.Union([
  PointerMove,
  PointerClick,
  PointerDrag,
  PointerScroll,
  KeyboardType,
  KeyboardKey,
  WindowFocus,
]);
export type DesktopUseAction = typeof DesktopUseAction.Type;

export const DesktopUseActionType = Schema.Literals([
  "pointer.move",
  "pointer.click",
  "pointer.drag",
  "pointer.scroll",
  "keyboard.type",
  "keyboard.key",
  "window.focus",
]);
export type DesktopUseActionType = typeof DesktopUseActionType.Type;

export const DesktopUseCaptureInput = Schema.Struct({
  displayId: Schema.optional(TrimmedNonEmptyString),
});
export type DesktopUseCaptureInput = typeof DesktopUseCaptureInput.Type;

export const DesktopUseInputRequest = Schema.Struct({
  displayId: Schema.optional(TrimmedNonEmptyString),
  action: DesktopUseAction,
});
export type DesktopUseInputRequest = typeof DesktopUseInputRequest.Type;

export const DesktopUseInputResult = Schema.Struct({
  cursor: Schema.optional(DesktopUseCursor),
});
export type DesktopUseInputResult = typeof DesktopUseInputResult.Type;

export const DesktopUseWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  appName: Schema.optional(TrimmedNonEmptyString),
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  active: Schema.Boolean,
});
export type DesktopUseWindow = typeof DesktopUseWindow.Type;

export const DesktopUseWindowList = Schema.Struct({
  windows: Schema.Array(DesktopUseWindow),
});
export type DesktopUseWindowList = typeof DesktopUseWindowList.Type;

export const DesktopUseSubscribeFramesInput = Schema.Struct({
  displayId: Schema.optional(TrimmedNonEmptyString),
  intervalMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(50)).check(Schema.isLessThanOrEqualTo(5_000)),
  ),
});
export type DesktopUseSubscribeFramesInput = typeof DesktopUseSubscribeFramesInput.Type;

export class DesktopUseUnavailableError extends Schema.TaggedError<DesktopUseUnavailableError>()(
  "DesktopUseUnavailableError",
  {
    platform: DesktopUsePlatform,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop use is unavailable on this node: ${this.reason}`;
  }
}

export class DesktopUseBackendError extends Schema.TaggedError<DesktopUseBackendError>()(
  "DesktopUseBackendError",
  {
    backend: DesktopUseBackend,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop use backend ${this.backend} failed during ${this.operation}.`;
  }
}

export class DesktopUsePolicyError extends Schema.TaggedError<DesktopUsePolicyError>()(
  "DesktopUsePolicyError",
  {
    reason: Schema.String,
    actionType: Schema.optional(DesktopUseActionType),
  },
) {
  override get message(): string {
    return `Desktop use action refused: ${this.reason}`;
  }
}

export class DesktopUseDisplayNotFoundError extends Schema.TaggedError<DesktopUseDisplayNotFoundError>()(
  "DesktopUseDisplayNotFoundError",
  {
    displayId: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Desktop use display not found: ${this.displayId}`;
  }
}

export class DesktopUseTimeoutError extends Schema.TaggedError<DesktopUseTimeoutError>()(
  "DesktopUseTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  },
) {
  override get message(): string {
    return `Desktop use ${this.operation} timed out after ${this.timeoutMs}ms.`;
  }
}

export const DesktopUseError = Schema.Union([
  DesktopUseUnavailableError,
  DesktopUseBackendError,
  DesktopUsePolicyError,
  DesktopUseDisplayNotFoundError,
  DesktopUseTimeoutError,
]);
export type DesktopUseError = typeof DesktopUseError.Type;
