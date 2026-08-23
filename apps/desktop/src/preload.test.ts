import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const { exposeInMainWorld, send } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  send: vi.fn(),
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
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { DESKTOP_PRELOAD_READY_CHANNEL } from "./ipc/channels.ts";
import { exposeDesktopBridge } from "./preload.ts";

describe("desktop preload bridge boundary", () => {
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
});
