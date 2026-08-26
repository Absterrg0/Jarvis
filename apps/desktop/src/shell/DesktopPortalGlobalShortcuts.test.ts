import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  JARVIS_PORTAL_VOICE_SHORTCUT_ID,
  attachDesktopPortalGlobalShortcuts,
} from "./DesktopPortalGlobalShortcuts.ts";

class TestVariant {
  readonly type: string;
  readonly value: unknown;

  constructor(type: string, value: unknown) {
    this.type = type;
    this.value = value;
  }
}

class TestMessage {
  readonly fields: Record<string, unknown>;

  constructor(fields: Record<string, unknown>) {
    this.fields = fields;
  }
}

describe("DesktopPortalGlobalShortcuts", () => {
  it("cleans up the pending portal response when CreateSession rejects", async () => {
    const busListeners = new Set<(message: never) => void>();
    const disconnect = vi.fn();
    const createPath = "/org/freedesktop/portal/desktop/request/1_77/cs_reject";
    const bus = {
      name: ":1.77",
      call: vi.fn(async () => undefined),
      on: vi.fn((_event: "message", listener: (message: never) => void) => {
        busListeners.add(listener);
      }),
      off: vi.fn((_event: "message", listener: (message: never) => void) => {
        busListeners.delete(listener);
      }),
      disconnect,
      getProxyObject: vi.fn(async () => ({
        getInterface: (name: string) => {
          if (name === "org.freedesktop.portal.GlobalShortcuts") {
            return {
              CreateSession: vi.fn(async () => {
                throw new Error("An app id is required");
              }),
              BindShortcuts: vi.fn(),
            };
          }
          throw new Error(`unexpected interface ${name}`);
        },
      })),
    };

    try {
      const handle = await attachDesktopPortalGlobalShortcuts({
        appId: "com.abstergo.jarvis",
        instanceToken: "reject",
        readCgroup: () =>
          "0::/user.slice/user-1000.slice/app.slice/app-com.abstergo.jarvis-test.scope",
        onActivated: vi.fn(),
        onDeactivated: vi.fn(),
        loadDbusNext: async () =>
          ({
            default: {
              sessionBus: () => bus,
              Variant: TestVariant,
              Message: TestMessage,
              MessageType: { SIGNAL: 4 },
            },
          }) as never,
      });

      expect(handle).toBeNull();
      expect(busListeners.size).toBe(0);
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      // Settle the leaked wait in the broken implementation so the red test
      // cannot leave a 15-second unhandled rejection behind.
      for (const listener of busListeners) {
        listener({ type: 4, path: createPath, member: "Response", body: [2, {}] } as never);
      }
    }
  });

  it("binds one hold shortcut and forwards its activated/deactivated edges", async () => {
    const busListeners = new Set<(message: never) => void>();
    const shortcutListeners = new Map<string, (...args: Array<unknown>) => void>();
    const onActivated = vi.fn();
    const onDeactivated = vi.fn();
    const Close = vi.fn(async () => undefined);
    const disconnect = vi.fn();

    const emitResponse = (path: string, results: Record<string, unknown>) => {
      queueMicrotask(() => {
        for (const listener of busListeners) {
          listener({ type: 4, path, member: "Response", body: [0, results] } as never);
        }
      });
    };
    const globalShortcuts = {
      CreateSession: vi.fn(async () => {
        emitResponse("/org/freedesktop/portal/desktop/request/1_99/cs_test", {
          session_handle: new TestVariant("s", "/org/freedesktop/portal/desktop/session/test"),
        });
        return "/request/create";
      }),
      ListShortcuts: vi.fn(async () => {
        emitResponse("/org/freedesktop/portal/desktop/request/1_99/ls_test", {
          shortcuts: new TestVariant("a(sa{sv})", []),
        });
        return "/request/list";
      }),
      BindShortcuts: vi.fn(async () => {
        emitResponse("/org/freedesktop/portal/desktop/request/1_99/bs_test", {});
        return "/request/bind";
      }),
      on: vi.fn((event: string, listener: (...args: Array<unknown>) => void) => {
        shortcutListeners.set(event, listener);
      }),
      off: vi.fn((event: string) => {
        shortcutListeners.delete(event);
      }),
    };
    const bus = {
      name: ":1.99",
      call: vi.fn(async () => undefined),
      on: vi.fn((_event: "message", listener: (message: never) => void) => {
        busListeners.add(listener);
      }),
      off: vi.fn((_event: "message", listener: (message: never) => void) => {
        busListeners.delete(listener);
      }),
      disconnect,
      getProxyObject: vi.fn(async (_name: string, path: string) => ({
        getInterface: (name: string) => {
          if (name === "org.freedesktop.portal.GlobalShortcuts") return globalShortcuts;
          if (name === "org.freedesktop.portal.Session") return { Close };
          if (name === "org.freedesktop.systemd1.Manager") {
            return { StartTransientUnit: vi.fn(async () => undefined) };
          }
          throw new Error(`unexpected interface ${name} at ${path}`);
        },
      })),
    };

    const handle = await attachDesktopPortalGlobalShortcuts({
      appId: "com.abstergo.jarvis",
      instanceToken: "test",
      readCgroup: () =>
        "0::/user.slice/user-1000.slice/app.slice/app-com.abstergo.jarvis-test.scope",
      onActivated,
      onDeactivated,
      loadDbusNext: async () =>
        ({
          default: {
            sessionBus: () => bus,
            Variant: TestVariant,
            Message: TestMessage,
            MessageType: { SIGNAL: 4 },
          },
        }) as never,
    });

    expect(handle).not.toBeNull();
    expect(globalShortcuts.CreateSession).toHaveBeenCalledTimes(1);
    expect(globalShortcuts.ListShortcuts).toHaveBeenCalledWith(
      "/org/freedesktop/portal/desktop/session/test",
      expect.any(Object),
    );
    expect(globalShortcuts.ListShortcuts.mock.invocationCallOrder[0]).toBeLessThan(
      globalShortcuts.BindShortcuts.mock.invocationCallOrder[0]!,
    );
    expect(globalShortcuts.BindShortcuts).toHaveBeenCalledWith(
      "/org/freedesktop/portal/desktop/session/test",
      expect.arrayContaining([
        [
          JARVIS_PORTAL_VOICE_SHORTCUT_ID,
          expect.objectContaining({ preferred_trigger: expect.any(TestVariant) }),
        ],
      ]),
      "",
      expect.any(Object),
    );

    shortcutListeners.get("Activated")?.("/session", JARVIS_PORTAL_VOICE_SHORTCUT_ID);
    shortcutListeners.get("Deactivated")?.("/session", JARVIS_PORTAL_VOICE_SHORTCUT_ID);
    expect(onActivated).toHaveBeenCalledWith(JARVIS_PORTAL_VOICE_SHORTCUT_ID);
    expect(onDeactivated).toHaveBeenCalledWith(JARVIS_PORTAL_VOICE_SHORTCUT_ID);

    await handle?.close();
    expect(Close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
