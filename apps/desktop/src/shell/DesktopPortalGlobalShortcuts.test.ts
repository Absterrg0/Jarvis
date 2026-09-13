import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  CIRCE_PORTAL_VOICE_SHORTCUT_ID,
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
  it("registers the host app id before creating a Wayland shortcut session", async () => {
    const busListeners = new Set<(message: never) => void>();
    const callOrder: string[] = [];
    const readCgroup = vi.fn(() => {
      throw new Error("cgroup is unavailable");
    });
    let registeredAppId: string | undefined;
    const Register = vi.fn(async (appId: string, _options: Record<string, unknown>) => {
      registeredAppId = appId;
      callOrder.push("register");
    });
    const emitResponse = (path: string, results: Record<string, unknown>) => {
      queueMicrotask(() => {
        for (const listener of busListeners) {
          listener({ type: 4, path, member: "Response", body: [0, results] } as never);
        }
      });
    };
    const globalShortcuts = {
      CreateSession: vi.fn(async () => {
        callOrder.push("create");
        if (registeredAppId !== "com.abstergo.circe") {
          throw new Error("A valid app id is required");
        }
        emitResponse("/org/freedesktop/portal/desktop/request/1_88/cs_host", {
          session_handle: new TestVariant("s", "/org/freedesktop/portal/desktop/session/host"),
        });
        return "/request/create";
      }),
      BindShortcuts: vi.fn(async () => {
        emitResponse("/org/freedesktop/portal/desktop/request/1_88/bs_host", {
          shortcuts: new TestVariant("a(sa{sv})", [[CIRCE_PORTAL_VOICE_SHORTCUT_ID, {}]]),
        });
        return "/request/bind";
      }),
      on: vi.fn(),
      off: vi.fn(),
    };
    const bus = {
      name: ":1.88",
      call: vi.fn(async () => undefined),
      on: vi.fn((_event: "message", listener: (message: never) => void) => {
        busListeners.add(listener);
      }),
      off: vi.fn((_event: "message", listener: (message: never) => void) => {
        busListeners.delete(listener);
      }),
      disconnect: vi.fn(),
      getProxyObject: vi.fn(async (_name: string, path: string) => ({
        getInterface: (name: string) => {
          if (name === "org.freedesktop.host.portal.Registry") return { Register };
          if (name === "org.freedesktop.portal.GlobalShortcuts") return globalShortcuts;
          if (name === "org.freedesktop.portal.Session") {
            return { Close: vi.fn(async () => undefined) };
          }
          throw new Error(`unexpected interface ${name} at ${path}`);
        },
      })),
    };

    const handle = await attachDesktopPortalGlobalShortcuts({
      appId: "com.abstergo.circe",
      instanceToken: "host",
      readCgroup,
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

    expect(handle).not.toBeNull();
    expect(Register).toHaveBeenCalledWith("com.abstergo.circe", {});
    expect(readCgroup).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["register", "create"]);
    await handle?.close();
  });

  it("falls back to the scope identity when the host registry rejects the app id", async () => {
    const busListeners = new Set<(message: never) => void>();
    const readCgroup = vi.fn(
      () => "0::/user.slice/user-1000.slice/app.slice/app-circe-realtime-fallback.scope",
    );
    const Register = vi.fn(async () => {
      throw new Error("App info not found for 'com.abstergo.circe.realtime'");
    });
    const emitResponse = (path: string, results: Record<string, unknown>) => {
      queueMicrotask(() => {
        for (const listener of busListeners) {
          listener({ type: 4, path, member: "Response", body: [0, results] } as never);
        }
      });
    };
    const globalShortcuts = {
      CreateSession: vi.fn(async () => {
        emitResponse("/org/freedesktop/portal/desktop/request/1_90/cs_fallback", {
          session_handle: new TestVariant("s", "/org/freedesktop/portal/desktop/session/fallback"),
        });
        return "/request/create";
      }),
      BindShortcuts: vi.fn(async () => {
        emitResponse("/org/freedesktop/portal/desktop/request/1_90/bs_fallback", {
          shortcuts: new TestVariant("a(sa{sv})", [[CIRCE_PORTAL_VOICE_SHORTCUT_ID, {}]]),
        });
        return "/request/bind";
      }),
      on: vi.fn(),
      off: vi.fn(),
    };
    const bus = {
      name: ":1.90",
      call: vi.fn(async () => undefined),
      on: vi.fn((_event: "message", listener: (message: never) => void) => {
        busListeners.add(listener);
      }),
      off: vi.fn((_event: "message", listener: (message: never) => void) => {
        busListeners.delete(listener);
      }),
      disconnect: vi.fn(),
      getProxyObject: vi.fn(async (_name: string, _path: string) => ({
        getInterface: (name: string) => {
          if (name === "org.freedesktop.host.portal.Registry") return { Register };
          if (name === "org.freedesktop.portal.GlobalShortcuts") return globalShortcuts;
          if (name === "org.freedesktop.portal.Session") {
            return { Close: vi.fn(async () => undefined) };
          }
          throw new Error(`unexpected interface ${name}`);
        },
      })),
    };

    const handle = await attachDesktopPortalGlobalShortcuts({
      appId: "com.abstergo.circe.realtime",
      instanceToken: "fallback",
      readCgroup,
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

    // Regression: a rejected host registration used to abort the whole
    // shortcut. It must fall back to the scope-derived identity and bind.
    expect(handle).not.toBeNull();
    expect(Register).toHaveBeenCalledWith("com.abstergo.circe.realtime", {});
    expect(readCgroup).toHaveBeenCalledTimes(1);
    await handle?.close();
  });

  it("rejects a successful bind response that does not contain the requested shortcut", async () => {
    const busListeners = new Set<(message: never) => void>();
    const disconnect = vi.fn();
    const Register = vi.fn(async () => undefined);
    const emitResponse = (path: string, results: Record<string, unknown>) => {
      queueMicrotask(() => {
        for (const listener of busListeners) {
          listener({ type: 4, path, member: "Response", body: [0, results] } as never);
        }
      });
    };
    const globalShortcuts = {
      CreateSession: vi.fn(async () => {
        emitResponse("/org/freedesktop/portal/desktop/request/1_89/cs_empty", {
          session_handle: new TestVariant("s", "/org/freedesktop/portal/desktop/session/empty"),
        });
        return "/request/create";
      }),
      BindShortcuts: vi.fn(async () => {
        emitResponse("/org/freedesktop/portal/desktop/request/1_89/bs_empty", {
          shortcuts: new TestVariant("a(sa{sv})", []),
        });
        return "/request/bind";
      }),
      on: vi.fn(),
      off: vi.fn(),
    };
    const bus = {
      name: ":1.89",
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
          if (name === "org.freedesktop.host.portal.Registry") return { Register };
          if (name === "org.freedesktop.portal.GlobalShortcuts") return globalShortcuts;
          if (name === "org.freedesktop.portal.Session") {
            return { Close: vi.fn(async () => undefined) };
          }
          throw new Error(`unexpected interface ${name} at ${path}`);
        },
      })),
    };

    const handle = await attachDesktopPortalGlobalShortcuts({
      appId: "com.abstergo.circe",
      instanceToken: "empty",
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
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

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
        appId: "com.abstergo.circe",
        instanceToken: "reject",
        readCgroup: () =>
          "0::/user.slice/user-1000.slice/app.slice/app-com.abstergo.circe-test.scope",
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
    const readCgroup = vi.fn(
      () => "0::/user.slice/user-1000.slice/app.slice/app-com.abstergo.circe-test.scope",
    );

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
          shortcuts: new TestVariant("a(sa{sv})", [[CIRCE_PORTAL_VOICE_SHORTCUT_ID, {}]]),
        });
        return "/request/list";
      }),
      BindShortcuts: vi.fn(async () => {
        emitResponse("/org/freedesktop/portal/desktop/request/1_99/bs_test", {
          shortcuts: new TestVariant("a(sa{sv})", [[CIRCE_PORTAL_VOICE_SHORTCUT_ID, {}]]),
        });
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
      appId: "com.abstergo.circe",
      instanceToken: "test",
      readCgroup,
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
    expect(readCgroup).toHaveBeenCalledTimes(1);
    expect(globalShortcuts.CreateSession).toHaveBeenCalledTimes(1);
    expect(globalShortcuts.ListShortcuts).not.toHaveBeenCalled();
    expect(globalShortcuts.BindShortcuts).toHaveBeenCalledTimes(1);
    expect(globalShortcuts.BindShortcuts).toHaveBeenCalledWith(
      "/org/freedesktop/portal/desktop/session/test",
      expect.arrayContaining([
        [
          CIRCE_PORTAL_VOICE_SHORTCUT_ID,
          expect.objectContaining({ preferred_trigger: expect.any(TestVariant) }),
        ],
      ]),
      "",
      expect.any(Object),
    );

    shortcutListeners.get("Activated")?.(
      "/org/freedesktop/portal/desktop/session/other",
      CIRCE_PORTAL_VOICE_SHORTCUT_ID,
    );
    shortcutListeners.get("Deactivated")?.(
      "/org/freedesktop/portal/desktop/session/other",
      CIRCE_PORTAL_VOICE_SHORTCUT_ID,
    );
    expect(onActivated).not.toHaveBeenCalled();
    expect(onDeactivated).not.toHaveBeenCalled();
    shortcutListeners.get("Activated")?.(
      "/org/freedesktop/portal/desktop/session/test",
      CIRCE_PORTAL_VOICE_SHORTCUT_ID,
    );
    shortcutListeners.get("Deactivated")?.(
      "/org/freedesktop/portal/desktop/session/test",
      CIRCE_PORTAL_VOICE_SHORTCUT_ID,
    );
    expect(onActivated).toHaveBeenCalledWith(CIRCE_PORTAL_VOICE_SHORTCUT_ID);
    expect(onDeactivated).toHaveBeenCalledWith(CIRCE_PORTAL_VOICE_SHORTCUT_ID);

    await handle?.close();
    expect(Close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
