import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  desktopLinuxPortalAppScopeUnitName,
  ensureDesktopLinuxPortalAppScope,
  readDesktopLinuxPortalAppIdFromCgroup,
} from "./DesktopLinuxPortalAppScope.ts";

class TestVariant {
  readonly type: string;
  readonly value: unknown;

  constructor(type: string, value: unknown) {
    this.type = type;
    this.value = value;
  }
}

describe("DesktopLinuxPortalAppScope", () => {
  it("builds the systemd unit name portal host apps require", () => {
    expect(desktopLinuxPortalAppScopeUnitName("com.abstergo.jarvis", "abc123")).toBe(
      "app-com.abstergo.jarvis-abc123.scope",
    );
  });

  it("reads the portal app id from a desktop app scope cgroup", () => {
    expect(
      readDesktopLinuxPortalAppIdFromCgroup(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-com.abstergo.jarvis-ae65e0f32221.scope",
      ),
    ).toBe("com.abstergo.jarvis");
    expect(
      readDesktopLinuxPortalAppIdFromCgroup(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.chromium.Chromium-6194.scope",
      ),
    ).toBe("org.chromium.Chromium");
    expect(
      readDesktopLinuxPortalAppIdFromCgroup("0::/user.slice/user-1000.slice/session.slice"),
    ).toBe(null);
  });

  it("skips StartTransientUnit when already inside any desktop app scope", async () => {
    const StartTransientUnit = vi.fn();
    const result = await ensureDesktopLinuxPortalAppScope({
      appId: "com.abstergo.jarvis",
      pid: 42,
      instance: "tok",
      bus: {
        getProxyObject: async () => ({
          getInterface: () => ({ StartTransientUnit }),
        }),
      },
      Variant: TestVariant,
      readCgroup: () =>
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-jarvis-244677.scope",
    });
    expect(result).toEqual({
      unit: "app-jarvis-tok.scope",
      alreadyScoped: true,
      effectiveAppId: "jarvis",
    });
    expect(StartTransientUnit).not.toHaveBeenCalled();
  });

  it("skips StartTransientUnit when already inside the matching app scope", async () => {
    const StartTransientUnit = vi.fn();
    const result = await ensureDesktopLinuxPortalAppScope({
      appId: "com.abstergo.jarvis",
      pid: 42,
      instance: "tok",
      bus: {
        getProxyObject: async () => ({
          getInterface: () => ({ StartTransientUnit }),
        }),
      },
      Variant: TestVariant,
      readCgroup: () =>
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-com.abstergo.jarvis-tok.scope",
    });
    expect(result).toEqual({
      unit: "app-com.abstergo.jarvis-tok.scope",
      alreadyScoped: true,
      effectiveAppId: "com.abstergo.jarvis",
    });
    expect(StartTransientUnit).not.toHaveBeenCalled();
  });

  it("moves the process into a transient app scope when needed", async () => {
    const StartTransientUnit = vi.fn(
      async (
        _name: string,
        _mode: string,
        _properties: ReadonlyArray<readonly [string, unknown]>,
        _aux: ReadonlyArray<unknown>,
      ) => "/job",
    );
    const result = await ensureDesktopLinuxPortalAppScope({
      appId: "com.abstergo.jarvis",
      pid: 42,
      instance: "tok",
      bus: {
        getProxyObject: async () => ({
          getInterface: () => ({ StartTransientUnit }),
        }),
      },
      Variant: TestVariant,
      readCgroup: () => "0::/user.slice/user-1000.slice/session.slice",
      delayMs: async () => undefined,
    });
    expect(result).toEqual({
      unit: "app-com.abstergo.jarvis-tok.scope",
      alreadyScoped: false,
      effectiveAppId: "com.abstergo.jarvis",
    });
    expect(StartTransientUnit).toHaveBeenCalledTimes(1);
    expect(StartTransientUnit.mock.calls[0]?.[0]).toBe("app-com.abstergo.jarvis-tok.scope");
    expect(StartTransientUnit.mock.calls[0]?.[2]).toEqual(
      expect.arrayContaining([["PIDs", expect.objectContaining({ type: "au", value: [42] })]]),
    );
  });
});
