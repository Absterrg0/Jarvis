// @effect-diagnostics globalTimers:off

/**
 * Legacy identity fallback for portals without the host Registry interface.
 * These portals can resolve a host app id from a user systemd scope named
 * `app-<appId>-<instance>.scope`. Modern portals register the app id directly
 * on the shortcut session's D-Bus connection instead.
 */

export type DesktopLinuxPortalAppScopeBus = {
  readonly getProxyObject: (
    name: string,
    path: string,
  ) => Promise<{
    readonly getInterface: (name: string) => unknown;
  }>;
};

type DesktopLinuxSystemdManager = {
  readonly StartTransientUnit: (
    name: string,
    mode: string,
    properties: ReadonlyArray<readonly [string, unknown]>,
    aux: ReadonlyArray<unknown>,
  ) => Promise<unknown>;
};

export type DesktopLinuxPortalAppScopeVariant = {
  new (type: string, value: unknown): unknown;
};

export function desktopLinuxPortalAppScopeUnitName(appId: string, instance: string): string {
  return `app-${appId}-${instance}.scope`;
}

export function readDesktopLinuxPortalAppIdFromCgroup(cgroup: string): string | null {
  for (const line of cgroup.split("\n")) {
    const scope = line.match(/\/(app-[^/\n]+)\.scope(?:\/|$)/)?.[1];
    if (scope === undefined) continue;
    // Captured unit stem is `app-<ApplicationID>-<RANDOM>` (no `.scope` suffix).
    // ApplicationID may contain dots; the instance token is the final segment.
    const withoutPrefix = scope.startsWith("app-") ? scope.slice("app-".length) : scope;
    const lastDash = withoutPrefix.lastIndexOf("-");
    if (lastDash <= 0) continue;
    const appId = withoutPrefix.slice(0, lastDash);
    if (appId.length > 0) return appId;
  }
  return null;
}

export async function ensureDesktopLinuxPortalAppScope(input: {
  readonly appId: string;
  readonly pid: number;
  readonly instance: string;
  readonly bus: DesktopLinuxPortalAppScopeBus;
  readonly Variant: DesktopLinuxPortalAppScopeVariant;
  readonly readCgroup?: () => string;
  readonly delayMs?: (ms: number) => Promise<void>;
}): Promise<{
  readonly unit: string;
  readonly alreadyScoped: boolean;
  readonly effectiveAppId: string;
}> {
  const unit = desktopLinuxPortalAppScopeUnitName(input.appId, input.instance);
  const readCgroup = input.readCgroup ?? (() => "");
  const cgroup = readCgroup();
  const currentAppId = readDesktopLinuxPortalAppIdFromCgroup(cgroup);
  // AppImageLauncher (and Flatpak) already place the process in an
  // `app-<id>-*.scope`. Moving out of that unit fails; the portal must use
  // the existing id (often `jarvis` from jarvis.desktop).
  if (currentAppId !== null) {
    return {
      unit:
        currentAppId === input.appId
          ? unit
          : desktopLinuxPortalAppScopeUnitName(currentAppId, input.instance),
      alreadyScoped: true,
      effectiveAppId: currentAppId,
    };
  }

  const systemd = await input.bus.getProxyObject(
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
  );
  const manager = systemd.getInterface(
    "org.freedesktop.systemd1.Manager",
  ) as DesktopLinuxSystemdManager;
  if (typeof manager.StartTransientUnit !== "function") {
    throw new Error("systemd D-Bus manager does not expose StartTransientUnit");
  }
  await manager.StartTransientUnit(
    unit,
    "fail",
    [
      ["Description", new input.Variant("s", `Jarvis (${input.appId})`)],
      ["PIDs", new input.Variant("au", [input.pid])],
      ["CollectMode", new input.Variant("s", "inactive-or-failed")],
    ],
    [],
  );
  const delayMs =
    input.delayMs ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  await delayMs(50);
  return { unit, alreadyScoped: false, effectiveAppId: input.appId };
}
