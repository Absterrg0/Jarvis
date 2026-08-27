import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
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

  it.each([
    {
      name: "any desktop app scope",
      cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-jarvis-244677.scope",
      expected: {
        unit: "app-jarvis-tok.scope",
        alreadyScoped: true,
        effectiveAppId: "jarvis",
      },
    },
    {
      name: "the matching app scope",
      cgroup:
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-com.abstergo.jarvis-tok.scope",
      expected: {
        unit: "app-com.abstergo.jarvis-tok.scope",
        alreadyScoped: true,
        effectiveAppId: "com.abstergo.jarvis",
      },
    },
  ])("skips StartTransientUnit when already inside $name", async ({ cgroup, expected }) => {
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
      readCgroup: () => cgroup,
    });
    expect(result).toEqual(expected);
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
