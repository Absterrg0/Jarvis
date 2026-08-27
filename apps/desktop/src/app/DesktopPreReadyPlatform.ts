// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads persisted settings synchronously before app services are available.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import { applyJarvisLinuxOzoneCommandLineSwitches } from "../../../../scripts/lib/jarvis-linux-electron-args.ts";

export interface DesktopPreReadyCommandLineReader {
  readonly hasSwitch: (switchName: string) => boolean;
  readonly getSwitchValue: (switchName: string) => string;
}

export function readCommandLineSwitchValue(
  commandLine: DesktopPreReadyCommandLineReader,
  switchName: string,
): string | null {
  if (!commandLine.hasSwitch(switchName)) {
    return null;
  }

  const value = commandLine.getSwitchValue(switchName).trim();
  return value.length > 0 ? value : null;
}

/**
 * Jarvis needs absolute window placement and a reliable global key hook for
 * its resident voice surface. Electron's native Wayland backend provides
 * neither on GNOME; use the already-available XWayland bridge unless the user
 * explicitly selected an Ozone platform. Chromium's hardware compositor can
 * crash on the XWayland + Intel/Mesa path even though its WebGL context is
 * healthy, so keep WebGL accelerated while compositing the small desktop
 * surfaces in software.
 */
export function resolveLinuxDesktopOzonePlatform(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly explicitOzonePlatform: string | null;
}): "x11" | null {
  if (input.explicitOzonePlatform !== null) return null;
  const sessionType = input.env.XDG_SESSION_TYPE?.trim().toLowerCase();
  const display = input.env.DISPLAY?.trim();
  return sessionType === "wayland" && display !== undefined && display.length > 0 ? "x11" : null;
}

export function configureLinuxDesktopOzonePlatformBeforeReady(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  readonly commandLine: {
    readonly appendSwitch: (switchName: string, value?: string) => void;
  };
}): void {
  if (input.platform !== "linux") return;
  const explicitArgument = input.argv.find((argument) => argument.startsWith("--ozone-platform="));
  const ozonePlatform = resolveLinuxDesktopOzonePlatform({
    env: input.env,
    explicitOzonePlatform: explicitArgument?.slice("--ozone-platform=".length) ?? null,
  });
  if (ozonePlatform !== null) {
    applyJarvisLinuxOzoneCommandLineSwitches(input.commandLine, ozonePlatform);
  }
}

export const resolveEarlyLinuxElectronOptionsFromProcess =
  (): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
    DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
      env: process.env,
      homeDirectory: NodeOS.homedir(),
      joinPath: NodePath.posix.join,
      readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
    });

export class DesktopPreReadyElectronOptions extends Context.Service<
  DesktopPreReadyElectronOptions,
  {
    readonly linux: DesktopEarlyElectronStartup.EarlyLinuxElectronOptions | null;
    readonly linuxPasswordStoreCommandLine: string | null;
  }
>()("@t3tools/desktop/app/DesktopPreReadyPlatform/DesktopPreReadyElectronOptions") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.sync((): DesktopPreReadyElectronOptions["Service"] => {
    const linuxPasswordStoreCommandLine =
      platform === "linux"
        ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
        : null;
    const linux = platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess() : null;

    if (linux !== null) {
      Electron.app.commandLine.appendSwitch("class", linux.linuxWmClass);
      if (linux.passwordStore !== null && linuxPasswordStoreCommandLine === null) {
        Electron.app.commandLine.appendSwitch("password-store", linux.passwordStore);
      }
    }

    return { linux, linuxPasswordStoreCommandLine };
  });
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

// Keep Electron's strict pre-ready setup isolated so later runtime layers cannot
// observe app readiness before scheme privileges and command-line switches exist.
export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
