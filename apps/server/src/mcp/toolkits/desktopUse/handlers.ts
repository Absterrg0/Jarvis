import * as Effect from "effect/Effect";

import * as DesktopUse from "../../../jarvis/desktopUse/DesktopUse.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DesktopUseToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const desktopUse = yield* DesktopUse.DesktopUse;
  const requireCapability = () => McpInvocationContext.requireMcpCapability("desktop-use");

  return DesktopUseToolkit.of({
    desktop_status: () => requireCapability().pipe(Effect.andThen(desktopUse.getStatus())),
    desktop_move: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: { type: "pointer.move", x: input.x, y: input.y },
          }),
        ),
      ),
    desktop_click: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: {
              type: "pointer.click",
              ...(input.x === undefined || input.y === undefined ? {} : { x: input.x, y: input.y }),
              ...(input.button === undefined ? {} : { button: input.button }),
              ...(input.count === undefined ? {} : { count: input.count }),
            },
          }),
        ),
      ),
    desktop_drag: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: {
              type: "pointer.drag",
              from: { x: input.fromX, y: input.fromY },
              to: { x: input.toX, y: input.toY },
              ...(input.button === undefined ? {} : { button: input.button }),
              ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
            },
          }),
        ),
      ),
    desktop_scroll: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: {
              type: "pointer.scroll",
              ...(input.x === undefined ? {} : { x: input.x }),
              ...(input.y === undefined ? {} : { y: input.y }),
              ...(input.deltaX === undefined ? {} : { deltaX: input.deltaX }),
              ...(input.deltaY === undefined ? {} : { deltaY: input.deltaY }),
            },
          }),
        ),
      ),
    desktop_type: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: { type: "keyboard.type", text: input.text },
          }),
        ),
      ),
    desktop_key: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: {
              type: "keyboard.key",
              key: input.key,
              ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
            },
          }),
        ),
      ),
    desktop_windows: () =>
      requireCapability().pipe(
        Effect.andThen(desktopUse.listWindows().pipe(Effect.map((windows) => ({ windows })))),
      ),
    desktop_focus_window: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({ action: { type: "window.focus", windowId: input.windowId } }),
        ),
      ),
  });
});

export const DesktopUseToolkitHandlersLive = DesktopUseToolkit.toLayer(make);
