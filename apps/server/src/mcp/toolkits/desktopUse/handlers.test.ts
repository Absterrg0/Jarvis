import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DesktopUseInputRequest,
  type DesktopUseStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as DesktopUse from "../../../circe/desktopUse/DesktopUse.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DesktopUseToolkitHandlersLive } from "./handlers.ts";
import { DesktopUseToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-desktop-use");
const environmentId = EnvironmentId.make("environment-desktop-use");

const status: DesktopUseStatus = {
  available: true,
  platform: "linux",
  backend: "linux-x11",
  displays: [{ id: "primary", x: 0, y: 0, width: 800, height: 600, scale: 1, primary: true }],
  supports: { capture: true, pointer: true, keyboard: true, windows: true },
};

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId: THREAD_ID,
  providerSessionId: "provider-session-desktop-use",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<DesktopUseInputRequest>>([]);
    const service = Layer.succeed(DesktopUse.DesktopUse, {
      getStatus: () => Effect.succeed(status),
      capture: () =>
        Effect.succeed({
          displayId: "primary",
          width: 800,
          height: 600,
          scale: 1,
          mimeType: "image/png" as const,
          data: "",
          capturedAt: 1,
        }),
      input: (request) =>
        Ref.update(calls, (existing) => [...existing, request]).pipe(
          Effect.as({ cursor: { x: 1, y: 2 } }),
        ),
      listWindows: () =>
        Effect.succeed([
          { id: "0x1", title: "Terminal", x: 0, y: 0, width: 10, height: 10, active: false },
        ]),
      subscribeFrames: () => Stream.empty,
    });
    const toolkit = yield* DesktopUseToolkit.pipe(
      Effect.provide(DesktopUseToolkitHandlersLive.pipe(Layer.provide(service))),
    );
    const call = <Name extends keyof typeof DesktopUseToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
      capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["desktop-use"],
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map(
          (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof DesktopUseToolkit.tools)[Name]>,
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provide(service),
      );
    return { calls, call };
  });

describe("desktop use toolkit handlers", () => {
  it.effect("refuses a credential without the desktop-use capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call("desktop_status", {}, ["preview"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "desktop-use",
      });
    }),
  );

  it.effect("maps desktop_move to a pointer move", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("desktop_move", { x: 12, y: 34 });
      expect(result).toEqual({ cursor: { x: 1, y: 2 } });
      const calls = yield* Ref.get(harness.calls);
      expect(calls).toEqual([{ action: { type: "pointer.move", x: 12, y: 34 } }]);
    }),
  );

  it.effect("maps desktop_click with and without coordinates", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("desktop_click", { x: 5, y: 6, button: "right", count: 2 });
      yield* harness.call("desktop_click", {});
      const calls = yield* Ref.get(harness.calls);
      expect(calls).toEqual([
        { action: { type: "pointer.click", x: 5, y: 6, button: "right", count: 2 } },
        { action: { type: "pointer.click" } },
      ]);
    }),
  );

  it.effect("maps desktop_type and desktop_key", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("desktop_type", { text: "hello" });
      yield* harness.call("desktop_key", { key: "enter", modifiers: ["control"] });
      const calls = yield* Ref.get(harness.calls);
      expect(calls).toEqual([
        { action: { type: "keyboard.type", text: "hello" } },
        { action: { type: "keyboard.key", key: "enter", modifiers: ["control"] } },
      ]);
    }),
  );

  it.effect("maps desktop_drag and desktop_scroll", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("desktop_drag", { fromX: 0, fromY: 0, toX: 9, toY: 9 });
      yield* harness.call("desktop_scroll", { x: 1, y: 2, deltaY: 120 });
      const calls = yield* Ref.get(harness.calls);
      expect(calls).toEqual([
        { action: { type: "pointer.drag", from: { x: 0, y: 0 }, to: { x: 9, y: 9 } } },
        { action: { type: "pointer.scroll", x: 1, y: 2, deltaY: 120 } },
      ]);
    }),
  );

  it.effect("returns status and wrapped window lists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call("desktop_status", {})).toEqual(status);
      expect(yield* harness.call("desktop_windows", {})).toEqual({
        windows: [
          { id: "0x1", title: "Terminal", x: 0, y: 0, width: 10, height: 10, active: false },
        ],
      });
    }),
  );
});
