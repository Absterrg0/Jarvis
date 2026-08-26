import * as NodeModule from "node:module";
import { describe, expect, it } from "@effect/vitest";

import { applyDesktopDbusNextElectronCompat } from "./DesktopDbusNextElectronCompat.ts";

describe("DesktopDbusNextElectronCompat", () => {
  it("keeps dbus-next on node:net instead of crashing through usocket", async () => {
    applyDesktopDbusNextElectronCompat();

    const require = NodeModule.createRequire(import.meta.url);
    expect(() => require("usocket")).toThrow(/usocket is disabled/);

    const dbus = await import("dbus-next");
    const bus = dbus.default.sessionBus();
    try {
      const dbusObject = await bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus");
      const iface = dbusObject.getInterface("org.freedesktop.DBus");
      const names = await (
        iface as typeof iface & { readonly ListNames: () => Promise<ReadonlyArray<string>> }
      ).ListNames();
      expect(Array.isArray(names)).toBe(true);
      expect(names).toContain("org.freedesktop.DBus");
    } finally {
      bus.disconnect();
    }
  });
});
