import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const { exposeInMainWorld, send, ipcOn } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  send: vi.fn(),
  ipcOn: vi.fn(),
}));

vi.mock("@clerk/electron/preload", () => ({
  exposeClerkBridge: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: {
    send,
    sendSync: vi.fn(),
    invoke: vi.fn(),
    on: ipcOn,
    removeListener: vi.fn(),
  },
}));

import type { DesktopBridge } from "@t3tools/contracts";

import {
  DESKTOP_PRELOAD_READY_CHANNEL,
  CIRCE_LIVE_VOICE_STATE_CHANNEL,
  CIRCE_LIVE_VOICE_TOGGLE_CHANNEL,
  CIRCE_ORB_CATALOG_CHANNEL,
  CIRCE_ORB_SELECT_CHANNEL,
} from "./ipc/channels.ts";
import {
  createCirceLiveVoiceToggleHub,
  createCirceOrbSelectHub,
  createMenuActionHub,
  exposeDesktopBridge,
  isCirceOrbSelection,
} from "./preload.ts";

function liveVoiceToggleHandler(): ((event: unknown) => void) | undefined {
  const call = ipcOn.mock.calls.find(([channel]) => channel === CIRCE_LIVE_VOICE_TOGGLE_CHANNEL);
  return call?.[1] as ((event: unknown) => void) | undefined;
}

function orbSelectHandler(): ((event: unknown, selection: unknown) => void) | undefined {
  const call = ipcOn.mock.calls.find(([channel]) => channel === CIRCE_ORB_SELECT_CHANNEL);
  return call?.[1] as ((event: unknown, selection: unknown) => void) | undefined;
}

// Captured at import time: a later test clears the expose mock, so call-order
// lookups after that point find only the empty test bridge.
const importTimeBridge = exposeInMainWorld.mock.calls[0]?.[1] as DesktopBridge;

describe("desktop preload bridge boundary", () => {
  it("delivers a live voice toggle that arrives before the runtime subscribes", async () => {
    const realBridge = exposeInMainWorld.mock.calls[0]?.[1] as DesktopBridge;
    const received: number[] = [];
    const handler = liveVoiceToggleHandler();
    assert.isDefined(handler);

    // Main can fire the hotkey during startup, before React subscribes.
    handler?.({});
    const unsubscribe = realBridge.circeLiveVoice?.onToggle(() => received.push(1));
    await Promise.resolve();

    assert.deepEqual(received, [1]);
    handler?.({});
    assert.deepEqual(received, [1, 1]);
    unsubscribe?.();
  });

  it("replays every pre-subscription live-voice toggle", async () => {
    const hub = createCirceLiveVoiceToggleHub();
    const received: number[] = [];

    hub.emit();
    hub.emit();
    const unsubscribe = hub.subscribe(() => received.push(1));
    await Promise.resolve();

    assert.deepEqual(received, [1, 1]);
    hub.emit();
    assert.deepEqual(received, [1, 1, 1]);
    unsubscribe();
  });

  it("forwards live conversation state to the main process", () => {
    // The import-time exposure call holds the real bridge before any test
    // clears the spy, so this must run first in file order.
    const realBridge = exposeInMainWorld.mock.calls[0]?.[1] as DesktopBridge;
    send.mockClear();

    realBridge.circeLiveVoice?.report({ enabled: true, active: true, status: "live" });

    assert.deepEqual(send.mock.calls, [
      [CIRCE_LIVE_VOICE_STATE_CHANNEL, { enabled: true, active: true, status: "live" }],
    ]);
  });

  it("exposes the bridge before sending the internal preload-ready marker", () => {
    exposeInMainWorld.mockClear();
    send.mockClear();

    const bridge = {};
    exposeDesktopBridge(bridge as never);

    assert.deepEqual(exposeInMainWorld.mock.calls, [["desktopBridge", bridge]]);
    assert.deepEqual(send.mock.calls, [[DESKTOP_PRELOAD_READY_CHANNEL]]);
    assert.isBelow(
      exposeInMainWorld.mock.invocationCallOrder[0] ?? Infinity,
      send.mock.invocationCallOrder[0] ?? -Infinity,
    );
  });

  it("replays a voice action that arrives before the renderer listener mounts", async () => {
    const hub = createMenuActionHub();
    const received: string[] = [];

    hub.emit("circe.live-voice-toggle");
    hub.subscribe((action) => received.push(action));
    await Promise.resolve();

    assert.deepEqual(received, ["circe.live-voice-toggle"]);
  });

  it("buffers orb selections that arrive before the reporter subscribes", async () => {
    const hub = createCirceOrbSelectHub();
    const received: Array<{ instanceId: string; model: string }> = [];

    hub.emit({ instanceId: "codex", model: "gpt-5" });
    const unsubscribe = hub.subscribe((selection) => received.push(selection));
    await Promise.resolve();

    assert.deepEqual(received, [{ instanceId: "codex", model: "gpt-5" }]);
    hub.emit({ instanceId: "claudeAgent", model: "sonnet" });
    assert.deepEqual(received, [
      { instanceId: "codex", model: "gpt-5" },
      { instanceId: "claudeAgent", model: "sonnet" },
    ]);
    unsubscribe();
  });

  it("preserves orb selection order across the pending flush gap", async () => {
    const hub = createCirceOrbSelectHub();
    const received: Array<{ instanceId: string; model: string }> = [];

    hub.emit({ instanceId: "codex", model: "gpt-5" });
    const unsubscribe = hub.subscribe((selection) => received.push(selection));
    hub.emit({ instanceId: "claudeAgent", model: "sonnet" });
    await Promise.resolve();

    assert.deepEqual(received, [
      { instanceId: "codex", model: "gpt-5" },
      { instanceId: "claudeAgent", model: "sonnet" },
    ]);
    unsubscribe();
  });

  it("validates orb selection payloads and forwards the catalog", () => {
    assert.isTrue(isCirceOrbSelection({ instanceId: "codex", model: "gpt-5" }));
    assert.isFalse(isCirceOrbSelection({ instanceId: "codex" }));
    assert.isFalse(isCirceOrbSelection("codex"));
    assert.isFalse(isCirceOrbSelection(null));

    // An earlier test replaces the exposed bridge with an empty one, so use
    // the import-time bridge captured before any test cleared the mock.
    const realBridge = importTimeBridge;
    assert.isDefined(realBridge.circeOrb);
    send.mockClear();
    realBridge?.circeOrb?.reportCatalog({
      providers: [],
      selected: null,
      pendingSelection: null,
      error: null,
    });
    assert.deepEqual(send.mock.calls, [
      [
        CIRCE_ORB_CATALOG_CHANNEL,
        { providers: [], selected: null, pendingSelection: null, error: null },
      ],
    ]);

    // Foreign payloads on the select channel never reach the reporter.
    const handler = orbSelectHandler();
    assert.isDefined(handler);
    const received: unknown[] = [];
    const unsubscribe = realBridge?.circeOrb?.onSelect((selection) => received.push(selection));
    handler?.({}, { instanceId: "codex" });
    assert.deepEqual(received, []);
    handler?.({}, { instanceId: "codex", model: "gpt-5" });
    assert.deepEqual(received, [{ instanceId: "codex", model: "gpt-5" }]);
    unsubscribe?.();
  });
});
