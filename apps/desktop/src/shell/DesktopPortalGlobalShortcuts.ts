// @effect-diagnostics nodeBuiltinImport:off globalTimers:off

/**
 * Linux hold-to-talk via org.freedesktop.portal.GlobalShortcuts.
 * Electron's globalShortcut only fires on key-down. The portal emits both
 * Activated and Deactivated, which is the production Wayland hold path.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { applyDesktopDbusNextElectronCompat } from "./DesktopDbusNextElectronCompat.ts";
import { ensureDesktopLinuxPortalAppScope } from "./DesktopLinuxPortalAppScope.ts";

export const JARVIS_PORTAL_VOICE_SHORTCUT_ID = "jarvis.voice";
export const JARVIS_PORTAL_VOICE_PREFERRED_TRIGGER = "CTRL+SHIFT+J";

type DbusVariant = { new (type: string, value: unknown): unknown };
type DbusMessageType = { readonly SIGNAL: number };
type DbusMessageCtor = new (fields: Record<string, unknown>) => unknown;

type DbusMessageBus = {
  readonly name: string;
  readonly call: (message: unknown) => Promise<unknown>;
  readonly on: (event: "message", listener: (message: DbusIncomingMessage) => void) => void;
  readonly off: (event: "message", listener: (message: DbusIncomingMessage) => void) => void;
  readonly disconnect: () => void;
  readonly getProxyObject: (
    name: string,
    path: string,
  ) => Promise<{
    readonly getInterface: (name: string) => DbusInterface;
  }>;
};

type DbusInterface = {
  readonly CreateSession?: (options: Record<string, unknown>) => Promise<string>;
  readonly BindShortcuts?: (
    sessionHandle: string,
    shortcuts: ReadonlyArray<readonly [string, Record<string, unknown>]>,
    parentWindow: string,
    options: Record<string, unknown>,
  ) => Promise<string>;
  readonly ListShortcuts?: (
    sessionHandle: string,
    options: Record<string, unknown>,
  ) => Promise<string>;
  readonly Close?: () => Promise<void>;
  readonly on?: (event: string, listener: (...args: Array<unknown>) => void) => void;
  readonly off?: (event: string, listener: (...args: Array<unknown>) => void) => void;
  readonly StartTransientUnit?: (
    name: string,
    mode: string,
    properties: ReadonlyArray<readonly [string, unknown]>,
    aux: ReadonlyArray<unknown>,
  ) => Promise<unknown>;
};

type DbusIncomingMessage = {
  readonly type: number;
  readonly path?: string;
  readonly interface?: string;
  readonly member?: string;
  readonly body: ReadonlyArray<unknown>;
};

type DbusNextModule = {
  readonly default: {
    readonly sessionBus: () => DbusMessageBus;
    readonly Variant: DbusVariant;
    readonly Message: DbusMessageCtor;
    readonly MessageType: DbusMessageType;
  };
  readonly sessionBus?: () => DbusMessageBus;
  readonly Variant?: DbusVariant;
  readonly Message?: DbusMessageCtor;
  readonly MessageType?: DbusMessageType;
};

export type DesktopPortalGlobalShortcutsHandle = {
  readonly close: () => Promise<void>;
};

export type AttachDesktopPortalGlobalShortcutsInput = {
  readonly appId: string;
  readonly shortcutId?: string;
  readonly preferredTrigger?: string;
  readonly description?: string;
  readonly parentWindow?: string;
  readonly onActivated: (shortcutId: string) => void;
  readonly onDeactivated: (shortcutId: string) => void;
  readonly bindTimeoutMs?: number;
  readonly loadDbusNext?: () => Promise<DbusNextModule>;
  readonly readCgroup?: () => string;
  readonly pid?: number;
  readonly instanceToken?: string;
};

function resolveDbus(module: DbusNextModule): {
  readonly sessionBus: () => DbusMessageBus;
  readonly Variant: DbusVariant;
  readonly Message: DbusMessageCtor;
  readonly MessageType: DbusMessageType;
} {
  const root = module.default ?? module;
  if (
    root.sessionBus === undefined ||
    root.Variant === undefined ||
    root.Message === undefined ||
    root.MessageType === undefined
  ) {
    throw new Error("dbus-next module is missing sessionBus/Variant/Message");
  }
  return {
    sessionBus: root.sessionBus,
    Variant: root.Variant,
    Message: root.Message,
    MessageType: root.MessageType,
  };
}

function variantValue(value: unknown): unknown {
  let current = value;
  while (
    current !== null &&
    typeof current === "object" &&
    "value" in current &&
    ("signature" in current || "type" in current)
  ) {
    current = (current as { value: unknown }).value;
  }
  return current;
}

function responseContainsShortcut(results: Record<string, unknown>, shortcutId: string): boolean {
  const shortcuts = variantValue(results.shortcuts);
  return (
    Array.isArray(shortcuts) &&
    shortcuts.some((shortcut) => Array.isArray(shortcut) && shortcut[0] === shortcutId)
  );
}

function portalRequestPath(busName: string, handleToken: string): string {
  const unique = busName.replace(":", "").replace(/\./g, "_");
  return `/org/freedesktop/portal/desktop/request/${unique}/${handleToken}`;
}

async function addResponseMatch(bus: DbusMessageBus, Message: DbusMessageCtor, path: string) {
  await bus.call(
    new Message({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "AddMatch",
      signature: "s",
      body: [
        `type='signal',sender='org.freedesktop.portal.Desktop',path='${path}',interface='org.freedesktop.portal.Request',member='Response'`,
      ],
    }),
  );
}

function waitPortalResponse(input: {
  readonly bus: DbusMessageBus;
  readonly MessageType: DbusMessageType;
  readonly path: string;
  readonly timeoutMs: number;
}): {
  readonly promise: Promise<{
    readonly response: number;
    readonly results: Record<string, unknown>;
  }>;
  readonly cancel: () => void;
} {
  let active = true;
  let cancel = (): void => undefined;
  const promise = new Promise<{
    readonly response: number;
    readonly results: Record<string, unknown>;
  }>((resolve, reject) => {
    const cleanup = (): void => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      input.bus.off("message", onMessage);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`portal request timed out: ${input.path}`));
    }, input.timeoutMs);
    const onMessage = (message: DbusIncomingMessage) => {
      if (message.type !== input.MessageType.SIGNAL) return;
      if (message.path !== input.path) return;
      if (message.member !== "Response") return;
      cleanup();
      resolve({
        response: Number(message.body[0]),
        results: (message.body[1] as Record<string, unknown> | undefined) ?? {},
      });
    };
    cancel = cleanup;
    input.bus.on("message", onMessage);
  });
  return { promise, cancel: () => cancel() };
}

const defaultLoadDbusNext = async (): Promise<DbusNextModule> =>
  import("dbus-next") as unknown as Promise<DbusNextModule>;

const defaultReadCgroup = (): string => {
  try {
    return NodeFS.readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
};

/**
 * Creates a GlobalShortcuts session, binds the Jarvis hold chord, and wires
 * Activated/Deactivated. Returns null when the portal is unavailable so the
 * shell can fall back to an honest tap-toggle.
 */
export async function attachDesktopPortalGlobalShortcuts(
  input: AttachDesktopPortalGlobalShortcutsInput,
): Promise<DesktopPortalGlobalShortcutsHandle | null> {
  const shortcutId = input.shortcutId ?? JARVIS_PORTAL_VOICE_SHORTCUT_ID;
  const preferredTrigger = input.preferredTrigger ?? JARVIS_PORTAL_VOICE_PREFERRED_TRIGGER;
  const description = input.description ?? "Hold to talk to Jarvis";
  const bindTimeoutMs = input.bindTimeoutMs ?? 120_000;
  const instanceToken = input.instanceToken ?? NodeCrypto.randomBytes(6).toString("hex");
  const pid = input.pid ?? process.pid;

  let dbusModule: DbusNextModule;
  try {
    applyDesktopDbusNextElectronCompat();
    dbusModule = await (input.loadDbusNext ?? defaultLoadDbusNext)();
  } catch {
    return null;
  }

  const dbus = resolveDbus(dbusModule);
  const bus = dbus.sessionBus();
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      bus.disconnect();
    } catch {
      // Session teardown is best effort during app quit.
    }
  };

  try {
    await ensureDesktopLinuxPortalAppScope({
      appId: input.appId,
      pid,
      instance: instanceToken,
      bus,
      Variant: dbus.Variant,
      readCgroup: input.readCgroup ?? defaultReadCgroup,
    });

    const portal = await bus.getProxyObject(
      "org.freedesktop.portal.Desktop",
      "/org/freedesktop/portal/desktop",
    );
    const globalShortcuts = portal.getInterface("org.freedesktop.portal.GlobalShortcuts");
    if (
      globalShortcuts.CreateSession === undefined ||
      globalShortcuts.BindShortcuts === undefined
    ) {
      await close();
      return null;
    }

    const createToken = `cs_${instanceToken}`;
    const createPath = portalRequestPath(bus.name, createToken);
    await addResponseMatch(bus, dbus.Message, createPath);
    const createResponse = waitPortalResponse({
      bus,
      MessageType: dbus.MessageType,
      path: createPath,
      timeoutMs: 15_000,
    });
    try {
      await globalShortcuts.CreateSession({
        handle_token: new dbus.Variant("s", createToken),
        session_handle_token: new dbus.Variant("s", `ss_${instanceToken}`),
      });
    } catch (cause) {
      createResponse.cancel();
      throw cause;
    }
    const created = await createResponse.promise;
    if (created.response !== 0) {
      await close();
      return null;
    }
    const sessionHandle = variantValue(created.results.session_handle);
    if (typeof sessionHandle !== "string" || sessionHandle.length === 0) {
      await close();
      return null;
    }

    const onActivated = (...args: Array<unknown>) => {
      const id = String(args[1] ?? "");
      if (id === shortcutId) input.onActivated(id);
    };
    const onDeactivated = (...args: Array<unknown>) => {
      const id = String(args[1] ?? "");
      if (id === shortcutId) input.onDeactivated(id);
    };
    globalShortcuts.on?.("Activated", onActivated);
    globalShortcuts.on?.("Deactivated", onDeactivated);

    let alreadyBound = false;
    if (globalShortcuts.ListShortcuts !== undefined) {
      const listToken = `ls_${instanceToken}`;
      const listPath = portalRequestPath(bus.name, listToken);
      const listResponse = waitPortalResponse({
        bus,
        MessageType: dbus.MessageType,
        path: listPath,
        timeoutMs: 5_000,
      });
      try {
        await addResponseMatch(bus, dbus.Message, listPath);
        await globalShortcuts.ListShortcuts(sessionHandle, {
          handle_token: new dbus.Variant("s", listToken),
        });
        const listed = await listResponse.promise;
        alreadyBound =
          listed.response === 0 && responseContainsShortcut(listed.results, shortcutId);
      } catch {
        listResponse.cancel();
      }
    }

    if (!alreadyBound) {
      const bindToken = `bs_${instanceToken}`;
      const bindPath = portalRequestPath(bus.name, bindToken);
      await addResponseMatch(bus, dbus.Message, bindPath);
      const bindResponse = waitPortalResponse({
        bus,
        MessageType: dbus.MessageType,
        path: bindPath,
        timeoutMs: bindTimeoutMs,
      });
      try {
        await globalShortcuts.BindShortcuts(
          sessionHandle,
          [
            [
              shortcutId,
              {
                description: new dbus.Variant("s", description),
                preferred_trigger: new dbus.Variant("s", preferredTrigger),
              },
            ],
          ],
          input.parentWindow ?? "",
          { handle_token: new dbus.Variant("s", bindToken) },
        );
      } catch (cause) {
        bindResponse.cancel();
        throw cause;
      }
      const bound = await bindResponse.promise;
      if (bound.response !== 0) {
        await close();
        return null;
      }
    }

    return {
      close: async () => {
        try {
          globalShortcuts.off?.("Activated", onActivated);
          globalShortcuts.off?.("Deactivated", onDeactivated);
        } catch {
          // Signal detach is best effort.
        }
        try {
          const session = await bus.getProxyObject("org.freedesktop.portal.Desktop", sessionHandle);
          await session.getInterface("org.freedesktop.portal.Session").Close?.();
        } catch {
          // Session may already be gone on logout.
        }
        await close();
      },
    };
  } catch {
    await close();
    return null;
  }
}
