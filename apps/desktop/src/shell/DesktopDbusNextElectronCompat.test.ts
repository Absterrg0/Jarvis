// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the test provisions a private D-Bus daemon with node:child_process and bounds the wait with a timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import { describe, expect, it } from "@effect/vitest";

import { applyDesktopDbusNextElectronCompat } from "./DesktopDbusNextElectronCompat.ts";

/**
 * Headless runners have no session bus. Start a private one so the round
 * trip stays hermetic instead of depending on ambient DISPLAY state.
 */
function startEphemeralSessionBus(): Promise<{ readonly stop: () => void } | null> {
  return new Promise((resolve) => {
    let daemon: NodeChildProcess.ChildProcess;
    try {
      daemon = NodeChildProcess.spawn(
        "dbus-daemon",
        ["--session", "--nofork", "--print-address=1"],
        {
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      resolve(null);
      return;
    }
    let output = "";
    const timer = setTimeout(() => {
      daemon.kill();
      resolve(null);
    }, 10_000);
    timer.unref?.();
    daemon.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    daemon.stdout?.once("data", (chunk: unknown) => {
      clearTimeout(timer);
      output += String(chunk);
      const address = output.split(/\r?\n/u, 1)[0]?.trim();
      if (!address) {
        daemon.kill();
        resolve(null);
        return;
      }
      process.env.DBUS_SESSION_BUS_ADDRESS = address;
      resolve({
        stop: () => {
          delete process.env.DBUS_SESSION_BUS_ADDRESS;
          daemon.kill();
        },
      });
    });
  });
}

describe("DesktopDbusNextElectronCompat", () => {
  it("keeps dbus-next on node:net instead of crashing through usocket", async () => {
    applyDesktopDbusNextElectronCompat();

    const require = NodeModule.createRequire(import.meta.url);
    expect(() => require("usocket")).toThrow(/usocket is disabled/);

    const ownsBus = process.env.DBUS_SESSION_BUS_ADDRESS === undefined;
    const ephemeral = ownsBus ? await startEphemeralSessionBus() : null;
    if (ownsBus && ephemeral === null) return;
    try {
      const dbus = await import("dbus-next");
      const bus = dbus.default.sessionBus();
      try {
        const dbusObject = await bus.getProxyObject(
          "org.freedesktop.DBus",
          "/org/freedesktop/DBus",
        );
        const iface = dbusObject.getInterface("org.freedesktop.DBus");
        const names = await (
          iface as typeof iface & { readonly ListNames: () => Promise<ReadonlyArray<string>> }
        ).ListNames();
        expect(Array.isArray(names)).toBe(true);
        expect(names).toContain("org.freedesktop.DBus");
      } finally {
        bus.disconnect();
      }
    } finally {
      ephemeral?.stop();
    }
  });
});
