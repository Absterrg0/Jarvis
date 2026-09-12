// @effect-diagnostics globalTimers:off nodeBuiltinImport:off -- this process boundary owns the
// dedicated XWayland overlay child used by native-Wayland desktop sessions.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  DesktopJarvisOrbCatalogSchema,
  type DesktopJarvisLiveVoiceState,
  type DesktopJarvisOrbCatalog,
  type DesktopJarvisOrbSelection,
} from "@t3tools/contracts";
import { JARVIS_ORB_CATALOG_CHANNEL } from "../ipc/channels.ts";
import { createDesktopJarvisLiveVoiceStateBridge } from "./DesktopJarvisLiveVoiceState.ts";
import {
  DESKTOP_JARVIS_ORB_MARGIN,
  DESKTOP_JARVIS_ORB_WINDOW_HEIGHT,
  DESKTOP_JARVIS_ORB_WINDOW_WIDTH,
  desktopJarvisOrbCatalogScript,
  desktopJarvisOrbStateScript,
  desktopJarvisOverlayDataUrl,
  parseDesktopJarvisOrbEvent,
} from "./DesktopJarvisOverlay.ts";
import { DESKTOP_JARVIS_OVERLAY_HELPER_FLAG } from "./DesktopJarvisOverlayHelper.ts";
import { attachDesktopPushToTalkHook, type DesktopPushToTalkHook } from "./DesktopPushToTalk.ts";
import {
  attachDesktopPortalGlobalShortcuts,
  type DesktopPortalGlobalShortcutsHandle,
} from "./DesktopPortalGlobalShortcuts.ts";

export const JARVIS_GLOBAL_SHORTCUT = "CommandOrControl+Shift+J";

export function shouldStartDesktopJarvisShell(
  distribution: DesktopEnvironment.DesktopDistribution,
): boolean {
  return distribution === "official-jarvis" || distribution === "unified-jarvis";
}

export function createDesktopJarvisRendererVoiceActions(dispatch: (action: string) => void): {
  readonly toggleLive: () => void;
} {
  return {
    toggleLive: () => dispatch("jarvis.live-voice-toggle"),
  };
}

const VOICE_OVERLAY_WIDTH = DESKTOP_JARVIS_ORB_WINDOW_WIDTH;
const VOICE_OVERLAY_HEIGHT = DESKTOP_JARVIS_ORB_WINDOW_HEIGHT;
const VOICE_OVERLAY_MARGIN = DESKTOP_JARVIS_ORB_MARGIN;
const TAP_SHORTCUT_REPEAT_GAP_MS = 1_200;

export function resolveDesktopJarvisOverlayPosition(
  workArea: Pick<Electron.Rectangle, "x" | "y" | "width" | "height">,
): { readonly x: number; readonly y: number } {
  return {
    x: Math.round(workArea.x + workArea.width - VOICE_OVERLAY_WIDTH - VOICE_OVERLAY_MARGIN),
    y: Math.round(workArea.y + (workArea.height - VOICE_OVERLAY_HEIGHT) / 2),
  };
}

export type DesktopJarvisOverlaySurface = "window" | "helper";

export function desktopJarvisOverlaySurface(
  platform: NodeJS.Platform,
  desktopSessionType: string | undefined,
): DesktopJarvisOverlaySurface {
  return platform === "linux" && desktopSessionType?.toLowerCase() === "wayland"
    ? "helper"
    : "window";
}

type DesktopJarvisOverlayHelper = {
  readonly send: (message: unknown) => void;
  readonly stop: () => void;
  readonly onStdoutLine?: (listener: (line: string) => void) => () => void;
};

const DESKTOP_JARVIS_OVERLAY_HELPER_SHUTDOWN_GRACE_MS = 2_000;

function createDesktopJarvisOverlayHelper(
  profileDir: string,
  onStdoutLine?: (line: string) => void,
): DesktopJarvisOverlayHelper | null {
  const appImage = process.env.APPIMAGE?.trim();
  const executable = appImage && appImage.length > 0 ? appImage : process.execPath;
  // The helper is a second Chromium profile, so it lives under the app
  // user-data directory (resolved by the composition layer), not in a shared
  // tmpdir where another user could pre-create the path.
  const userDataDir = profileDir;
  try {
    NodeFS.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  try {
    const child = NodeChildProcess.spawn(executable, desktopJarvisOverlayHelperArgs(userDataDir), {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let running = true;
    child.once("exit", () => {
      running = false;
    });
    child.once("error", () => {
      running = false;
    });
    // A write to a dead pipe surfaces as an async stdin "error", not a
    // thrown write. Without this listener it becomes an uncaught exception.
    child.stdin?.once("error", () => {
      running = false;
    });
    // The helper reports orb picker selections on stdout as JSON lines. Split
    // them here so a partial write can never corrupt the next report.
    if (onStdoutLine !== undefined && child.stdout !== null) {
      let buffered = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        buffered += chunk.toString("utf8");
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.trim().length > 0) {
            try {
              onStdoutLine(line);
            } catch {
              // A bad listener must not break the helper stdout pump.
            }
          }
          newline = buffered.indexOf("\n");
        }
      });
    }
    return {
      send(message) {
        if (!running || child.stdin === null || child.stdin.destroyed) return;
        child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      stop() {
        if (!running) return;
        running = false;
        if (child.stdin !== null && !child.stdin.destroyed) {
          child.stdin.write('{"type":"shutdown"}\n');
          child.stdin.end();
        }
        // If the helper ignores the shutdown request, do not leave a
        // Chromium process holding the profile directory behind.
        const killTimer = setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill();
          } catch {
            // The child already exited; nothing left to stop.
          }
        }, DESKTOP_JARVIS_OVERLAY_HELPER_SHUTDOWN_GRACE_MS);
        killTimer.unref?.();
      },
    };
  } catch {
    return null;
  }
}

export function desktopJarvisOverlayHelperArgs(userDataDir: string): ReadonlyArray<string> {
  return [
    "--no-sandbox",
    "--ozone-platform=x11",
    `--user-data-dir=${userDataDir}`,
    DESKTOP_JARVIS_OVERLAY_HELPER_FLAG,
  ];
}

const loadDesktopPushToTalkHook = async (): Promise<DesktopPushToTalkHook | null> => {
  try {
    // Keep this optional: distributions that do not ship the native module
    // retain Electron's tap fallback instead of making the shell fail.
    const moduleName = "uiohook-napi";
    const module = (await import(moduleName)) as {
      readonly uIOhook?: DesktopPushToTalkHook;
    };
    return module.uIOhook ?? null;
  } catch {
    return null;
  }
};

export function resolveDesktopJarvisTrayIconPath(
  platform: NodeJS.Platform,
  iconPaths: DesktopAssets.DesktopIconPaths,
): string | null {
  const preferred = platform === "win32" ? iconPaths.ico : iconPaths.png;
  const fallback = platform === "win32" ? iconPaths.png : iconPaths.ico;
  return Option.getOrElse(preferred, () => Option.getOrElse(fallback, () => null));
}

export interface DesktopJarvisShellRuntime {
  readonly start: () => void;
  readonly stop: () => void;
  readonly talk: () => void;
  readonly open: () => void;
  /** Renderer pushed a fresh provider catalog; forward it to the orb surface. */
  readonly pushOrbCatalog: (catalog: DesktopJarvisOrbCatalog) => void;
}

export interface DesktopJarvisShellInput {
  readonly displayName: string;
  readonly iconPath: string | null;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly desktopSessionType?: string;
  readonly globalShortcut?: Pick<typeof Electron.globalShortcut, "register" | "unregister">;
  readonly pushToTalkHook?: DesktopPushToTalkHook;
  readonly loadPushToTalkHook?: () => Promise<DesktopPushToTalkHook | null>;
  /**
   * Linux hold-to-talk via xdg-desktop-portal GlobalShortcuts. Unit tests pass
   * an explicit stub; production wires the real portal client from the layer.
   * `undefined` means "use the default portal installer on linux".
   */
  readonly installPortalHoldShortcut?: (handlers: {
    readonly onPressed: () => void;
    readonly onReleased: () => void;
  }) => Promise<DesktopPortalGlobalShortcutsHandle | null>;
  readonly createTray?: (icon: string | Electron.NativeImage) => Electron.Tray;
  readonly buildTrayMenu?: (template: Electron.MenuItemConstructorOptions[]) => Electron.Menu;
  readonly createOverlay?: () => Electron.BrowserWindow;
  /**
   * Injectable helper factory. Unit tests pass an explicit stub; production
   * uses the real XWayland child. `undefined` disables the helper overlay.
   */
  readonly spawnOverlayHelper?: (
    profileDir: string,
    onStdoutLine: (line: string) => void,
  ) => DesktopJarvisOverlayHelper | null;
  /**
   * Orb picker selection, relayed orb -> main -> renderer. The layer forwards
   * it to the main renderer, which validates it against the real catalog and
   * saves it through the ordinary settings API.
   */
  readonly onOrbSelect?: (selection: DesktopJarvisOrbSelection) => void;
  /** Latest orb provider catalog supplied by the renderer, if any. */
  readonly getOrbCatalog?: () => DesktopJarvisOrbCatalog | null;
  /**
   * Chromium profile directory for the Wayland overlay helper. Unit tests
   * pass an explicit stub; production wires the app user-data directory from
   * the layer. `undefined` disables the helper overlay.
   */
  readonly overlayProfileDir?: string;
  readonly sendLiveVoiceToggle?: () => void;
  readonly revealMain: () => void;
  readonly quit: () => void;
  readonly setCloseToTrayEnabled?: (enabled: boolean) => void;
  readonly onLiveVoiceState?: (
    listener: (state: DesktopJarvisLiveVoiceState) => void,
  ) => () => void;
  readonly getLiveVoiceState?: () => DesktopJarvisLiveVoiceState;
  readonly now?: () => number;
  readonly getOverlayWorkArea?: () => Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;
}

/**
 * The Full Desktop shell owns the resident command surface. It deliberately
 * has no renderer of its own beyond a tiny status overlay. The live
 * conversation owns the hotkey; the already-loaded renderer remains the
 * session owner.
 */
export function createDesktopJarvisShell(
  input: DesktopJarvisShellInput,
): DesktopJarvisShellRuntime {
  const shortcut = input.globalShortcut ?? Electron.globalShortcut;
  const makeTray = input.createTray ?? ((icon) => new Electron.Tray(icon));
  const buildTrayMenu =
    input.buildTrayMenu ?? ((template) => Electron.Menu.buildFromTemplate(template));
  const now = input.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  let tray: Electron.Tray | null = null;
  let overlay: Electron.BrowserWindow | null = null;
  let overlayHelper: DesktopJarvisOverlayHelper | null = null;
  const overlaySurface = desktopJarvisOverlaySurface(input.platform, input.desktopSessionType);
  let shortcutRegistered = false;
  let removePushToTalk: (() => void) | null = null;
  let portalHold: DesktopPortalGlobalShortcutsHandle | null = null;
  let pushToTalkLoadGeneration = 0;

  const clearElectronTapShortcut = (): void => {
    if (!shortcutRegistered) return;
    try {
      shortcut.unregister(JARVIS_GLOBAL_SHORTCUT);
    } catch {
      // Electron may already have released the accelerator during teardown.
    }
    shortcutRegistered = false;
  };

  const installElectronTapShortcut = (): void => {
    if (stopped || shortcutRegistered) return;
    try {
      shortcutRegistered = shortcut.register(JARVIS_GLOBAL_SHORTCUT, activateTapShortcut);
    } catch {
      shortcutRegistered = false;
    }
    refreshTrayMenu();
  };
  let started = false;
  let stopped = false;
  let removeLiveVoiceStateListener: (() => void) | null = null;
  let liveVoiceState: DesktopJarvisLiveVoiceState = {
    enabled: false,
    active: false,
    status: "idle",
  };
  // Set when a press was routed to live conversation, so the matching release
  // ends nothing: live is a toggle, not a hold.
  let liveToggleHeld = false;
  let overlayReady = false;
  let pendingOrbState: DesktopJarvisLiveVoiceState | null = null;
  let pendingOrbCatalog: DesktopJarvisOrbCatalog | null = null;
  let orbCatalog: DesktopJarvisOrbCatalog | null = null;
  let lastTapShortcutActivationAt = Number.NEGATIVE_INFINITY;

  /** The orb glow follows the real live session. */
  const resolveOrbLiveState = (): DesktopJarvisLiveVoiceState => liveVoiceState;

  const handleOrbConsoleLine = (line: string): void => {
    if (stopped) return;
    const selection = parseDesktopJarvisOrbEvent(line);
    if (selection === null) return;
    input.onOrbSelect?.(selection);
  };

  const attachOrbConsoleBridge = (window: Electron.BrowserWindow): void => {
    try {
      const contents = window.webContents as unknown as {
        on?: (event: string, listener: (...args: Array<never>) => void) => void;
      };
      contents.on?.("console-message", (_event: never, _level: never, message: never) => {
        if (typeof message === "string") handleOrbConsoleLine(message);
      });
    } catch {
      // Console bridging is best effort; selections also arrive via helper stdout.
    }
  };

  const ensureOverlay = (): Electron.BrowserWindow | null => {
    if (overlaySurface === "helper") {
      if (overlayHelper === null) {
        const spawn = input.spawnOverlayHelper;
        if (spawn !== undefined && input.overlayProfileDir !== undefined) {
          overlayHelper = spawn(input.overlayProfileDir, handleOrbConsoleLine);
        } else if (input.overlayProfileDir !== undefined) {
          overlayHelper = createDesktopJarvisOverlayHelper(
            input.overlayProfileDir,
            handleOrbConsoleLine,
          );
        }
      }
      return null;
    }
    if (overlay !== null && !overlay.isDestroyed()) return overlay;
    if (input.createOverlay === undefined) {
      try {
        overlay = new Electron.BrowserWindow({
          width: VOICE_OVERLAY_WIDTH,
          height: VOICE_OVERLAY_HEIGHT,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          frame: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
          focusable: false,
          show: false,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        overlay.setAlwaysOnTop(true, "floating");
        overlayReady = false;
        attachOrbConsoleBridge(overlay);
        overlay.webContents.once("did-finish-load", () => {
          overlayReady = true;
          if (pendingOrbState !== null) pushOrbState(pendingOrbState);
          if (pendingOrbCatalog !== null) pushOrbCatalogToSurface(pendingOrbCatalog);
          else if (orbCatalog !== null) pushOrbCatalogToSurface(orbCatalog);
        });
        void overlay.loadURL(desktopJarvisOverlayDataUrl());
      } catch {
        overlay = null;
      }
    } else {
      try {
        overlay = input.createOverlay();
        overlayReady = false;
        attachOrbConsoleBridge(overlay);
        overlay.webContents.once("did-finish-load", () => {
          overlayReady = true;
          if (pendingOrbState !== null) pushOrbState(pendingOrbState);
          if (pendingOrbCatalog !== null) pushOrbCatalogToSurface(pendingOrbCatalog);
          else if (orbCatalog !== null) pushOrbCatalogToSurface(orbCatalog);
        });
      } catch {
        overlay = null;
      }
    }
    return overlay;
  };

  const showOverlay = (): void => {
    // Late voice callbacks can arrive after stop(); never resurrect the
    // overlay once the shell is torn down.
    if (stopped) return;
    if (overlaySurface === "helper") {
      ensureOverlay();
      overlayHelper?.send({ type: "show" });
      return;
    }
    const window = ensureOverlay();
    if (window === null || window.isDestroyed()) return;
    try {
      if (typeof window.setPosition === "function") {
        const workArea =
          input.getOverlayWorkArea?.() ??
          Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()).workArea;
        const position = resolveDesktopJarvisOverlayPosition(workArea);
        window.setPosition(position.x, position.y, false);
      }
    } catch {
      // Display topology can change while a voice window is being shown.
    }
    try {
      if (typeof window.showInactive === "function") window.showInactive();
      else window.show();
    } catch {
      // The overlay is best-effort UX and must never break the voice shortcut.
    }
  };

  const pushOrbState = (state: DesktopJarvisLiveVoiceState): void => {
    if (stopped) return;
    pendingOrbState = state;
    if (overlaySurface === "helper") {
      ensureOverlay();
      overlayHelper?.send({ type: "orb-state", state });
      return;
    }
    const window = overlay;
    if (window === null || window.isDestroyed() || !overlayReady) return;
    try {
      void window.webContents.executeJavaScript(desktopJarvisOrbStateScript(state), true);
    } catch {
      // Overlay updates are best effort while its renderer is starting/closing.
    }
  };

  const pushOrbCatalogToSurface = (catalog: DesktopJarvisOrbCatalog): void => {
    if (stopped) return;
    pendingOrbCatalog = catalog;
    if (overlaySurface === "helper") {
      ensureOverlay();
      overlayHelper?.send({ type: "orb-catalog", catalog });
      return;
    }
    const window = overlay;
    if (window === null || window.isDestroyed() || !overlayReady) return;
    try {
      void window.webContents.executeJavaScript(desktopJarvisOrbCatalogScript(catalog), true);
    } catch {
      // Overlay updates are best effort while its renderer is starting/closing.
    }
  };

  /** Push the resolved glow plus the latest catalog; the orb stays visible. */
  const refreshOrbSurface = (): void => {
    if (stopped) return;
    showOverlay();
    pushOrbState(resolveOrbLiveState());
    const catalog = orbCatalog ?? input.getOrbCatalog?.() ?? null;
    if (catalog !== null) pushOrbCatalogToSurface(catalog);
  };

  const hideOverlay = (): void => {
    if (overlaySurface === "helper") {
      overlayHelper?.send({ type: "hide" });
      return;
    }
    if (overlay === null || overlay.isDestroyed()) return;
    try {
      overlay.hide();
    } catch {
      // Window teardown can race the hide request on Windows.
    }
  };

  const talk = (): void => {
    if (stopped) return;
    // The one hotkey owns a full-duplex live conversation toggle. The orb
    // stays up so the user sees the session start.
    liveToggleHeld = true;
    refreshOrbSurface();
    input.sendLiveVoiceToggle?.();
  };

  const activateTapShortcut = (): void => {
    const activatedAt = now();
    const elapsed = activatedAt - lastTapShortcutActivationAt;
    lastTapShortcutActivationAt = activatedAt;
    // globalShortcut has no key-up edge. Ignore every activation in the OS
    // repeat stream and accept a second tap only after the stream went quiet.
    if (elapsed < TAP_SHORTCUT_REPEAT_GAP_MS) return;
    talk();
  };

  const startTalk = (): void => {
    if (stopped) return;
    // Hold hardware acts as a tap for live: press toggles, release clears.
    liveToggleHeld = true;
    refreshOrbSurface();
    input.sendLiveVoiceToggle?.();
  };

  const releaseTalk = (): void => {
    if (stopped) return;
    if (liveToggleHeld) {
      liveToggleHeld = false;
    }
  };

  const refreshTrayMenu = (): void => {
    if (tray === null) return;
    const shortcutLabel = input.platform === "darwin" ? "Command+Shift+J" : "Ctrl+Shift+J";
    const voiceItemLabel = (() => {
      if (!liveVoiceState.active) return `Start live conversation (${shortcutLabel})`;
      switch (liveVoiceState.status) {
        case "live":
          return `End live conversation (${shortcutLabel})`;
        case "closing":
          return "Ending live conversation…";
        default:
          return "Live conversation connecting…";
      }
    })();
    try {
      tray.setContextMenu(
        buildTrayMenu([
          { label: "Open ARIS", click: open },
          { label: voiceItemLabel, click: talk },
          { type: "separator" },
          { label: "Quit", click: input.quit },
        ]),
      );
    } catch {
      // Tray menus are best effort during app shutdown.
    }
  };

  const promoteToHold = (detach: () => void): void => {
    removePushToTalk = detach;
    clearElectronTapShortcut();
    refreshTrayMenu();
  };

  const installPortalHold = async (generation: number): Promise<boolean> => {
    if (input.platform !== "linux" || input.installPortalHoldShortcut === undefined) {
      return false;
    }
    const install = input.installPortalHoldShortcut;
    let handle: DesktopPortalGlobalShortcutsHandle | null = null;
    try {
      handle = await install({ onPressed: startTalk, onReleased: releaseTalk });
    } catch {
      handle = null;
    }
    if (stopped || generation !== pushToTalkLoadGeneration) {
      void handle?.close().catch(() => undefined);
      return true;
    }
    if (handle === null) return false;
    portalHold = handle;
    promoteToHold(() => {
      const current = portalHold;
      portalHold = null;
      void current?.close().catch(() => undefined);
    });
    return true;
  };

  const installNativeHookHold = async (generation: number): Promise<boolean> => {
    let hook: DesktopPushToTalkHook | null = null;
    // Windows: native uiohook is the hold path. Linux X11: optional fallback
    // when the portal is missing. Never load uiohook under Wayland — Xkb map
    // init fails and we must not pretend hold works.
    const nativeHookEligible =
      input.architecture === "x64" &&
      (input.platform === "win32" ||
        (input.platform === "linux" && input.desktopSessionType?.toLowerCase() !== "wayland"));
    if (!nativeHookEligible) return false;
    try {
      hook =
        input.pushToTalkHook ?? (await (input.loadPushToTalkHook ?? loadDesktopPushToTalkHook)());
    } catch {
      hook = null;
    }
    if (stopped || generation !== pushToTalkLoadGeneration) {
      try {
        hook?.stop();
      } catch {
        // A late native module load must not revive a disposed shell.
      }
      return true;
    }
    if (hook === null) return false;
    try {
      const detach = attachDesktopPushToTalkHook({
        hook,
        onPressed: startTalk,
        onReleased: releaseTalk,
        releaseOnJ: input.platform === "win32",
      });
      if (stopped || generation !== pushToTalkLoadGeneration) {
        detach();
        return true;
      }
      promoteToHold(detach);
      return true;
    } catch {
      try {
        hook.stop();
      } catch {
        // Native hook setup is optional and must fail closed.
      }
      return false;
    }
  };

  const installPushToTalk = async (): Promise<void> => {
    const generation = pushToTalkLoadGeneration;
    // Only await the portal path when Linux actually wired an installer. A
    // no-op async return would yield a microtask and race dispose tests that
    // resolve a pending native-hook promise in the same turn as stop().
    if (input.platform === "linux" && input.installPortalHoldShortcut !== undefined) {
      if (await installPortalHold(generation)) {
        if (stopped || generation !== pushToTalkLoadGeneration) return;
        if (removePushToTalk !== null) return;
      }
    }
    if (await installNativeHookHold(generation)) {
      if (stopped || generation !== pushToTalkLoadGeneration) return;
      if (removePushToTalk !== null) return;
    }
    if (stopped || generation !== pushToTalkLoadGeneration) return;
    // Honest fallback: Electron tap-toggle has no key-up. Install it only
    // after hold setup has failed so one physical chord can never change modes
    // between its down and up edges.
    installElectronTapShortcut();
  };

  const open = (): void => {
    if (stopped) return;
    // The orb is persistent; revealing the workspace leaves it up.
    input.revealMain();
  };

  const pushOrbCatalog = (catalog: DesktopJarvisOrbCatalog): void => {
    if (stopped) return;
    orbCatalog = catalog;
    pushOrbCatalogToSurface(catalog);
  };

  const start = (): void => {
    if (started || stopped) return;
    started = true;
    orbCatalog = input.getOrbCatalog?.() ?? null;
    if (overlaySurface === "helper") ensureOverlay();
    liveVoiceState = input.getLiveVoiceState?.() ?? liveVoiceState;
    removeLiveVoiceStateListener =
      input.onLiveVoiceState?.((state) => {
        liveVoiceState = state;
        if (!state.enabled) liveToggleHeld = false;
        refreshTrayMenu();
        refreshOrbSurface();
      }) ?? null;
    // ARIS residency is a lifecycle guarantee. A tray is only an optional
    // navigation affordance and must not decide whether closing exits the app.
    input.setCloseToTrayEnabled?.(true);
    try {
      if (input.iconPath !== null) {
        const icon = input.iconPath;
        tray = makeTray(icon);
        tray.setToolTip(input.displayName);
        refreshTrayMenu();
        tray.on("click", open);
      }
    } catch {
      tray = null;
    }
    if (input.platform === "darwin") installElectronTapShortcut();
    else void installPushToTalk();
    // The orb is persistent: visible idle, glowing while a session runs.
    refreshOrbSurface();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    pushToTalkLoadGeneration += 1;
    removeLiveVoiceStateListener?.();
    removeLiveVoiceStateListener = null;
    liveToggleHeld = false;
    input.setCloseToTrayEnabled?.(false);
    removePushToTalk?.();
    removePushToTalk = null;
    portalHold = null;
    clearElectronTapShortcut();
    hideOverlay();
    overlayHelper?.stop();
    overlayHelper = null;
    if (overlay !== null && !overlay.isDestroyed() && typeof overlay.close === "function") {
      overlay.close();
    }
    overlay = null;
    orbCatalog = null;
    pendingOrbCatalog = null;
    pendingOrbState = null;
    overlayReady = false;
    lastTapShortcutActivationAt = Number.NEGATIVE_INFINITY;
    if (tray !== null) {
      try {
        tray.destroy();
      } catch {
        // Tray destruction is idempotent from the shell's perspective.
      }
      tray = null;
    }
  };

  return { start, stop, talk, open, pushOrbCatalog };
}

export class DesktopJarvisShell extends Context.Service<
  DesktopJarvisShell,
  {
    readonly start: Effect.Effect<void>;
    readonly stop: Effect.Effect<void>;
  }
>()("@t3tools/desktop/shell/DesktopJarvisShell") {}

export const layer = Layer.effect(
  DesktopJarvisShell,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const assets = yield* DesktopAssets.DesktopAssets;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const iconPaths = yield* assets.iconPaths;
    const icon = resolveDesktopJarvisTrayIconPath(environment.platform, iconPaths);
    const context = yield* Effect.context<
      DesktopEnvironment.DesktopEnvironment | DesktopWindow.DesktopWindow | ElectronApp.ElectronApp
    >();
    const run = Effect.runPromiseWith(context);
    // One process-lifetime subscription: the shell layer is memoized once per
    // app build, and the bridge outlives every session it reports.
    const liveVoiceBridge = createDesktopJarvisLiveVoiceStateBridge(Electron.ipcMain);
    const decodeOrbCatalog = Schema.decodeUnknownOption(DesktopJarvisOrbCatalogSchema);
    let runtime: DesktopJarvisShellRuntime | null = null;
    // Renderer-owned provider catalog for the orb picker. Invalid reports
    // leave the last known catalog alone; the orb never invents providers.
    Electron.ipcMain.on(JARVIS_ORB_CATALOG_CHANNEL, (_event: unknown, raw: unknown) => {
      const decoded = decodeOrbCatalog(raw);
      if (Option.isNone(decoded)) return;
      runtime?.pushOrbCatalog(decoded.value);
    });
    runtime = createDesktopJarvisShell({
      displayName: environment.displayName,
      iconPath: icon,
      platform: environment.platform,
      architecture: environment.processArch as NodeJS.Architecture,
      overlayProfileDir: NodePath.join(Electron.app.getPath("userData"), "jarvis-overlay-profile"),
      ...(process.env.XDG_SESSION_TYPE === undefined
        ? {}
        : { desktopSessionType: process.env.XDG_SESSION_TYPE }),
      ...(environment.platform === "linux"
        ? {
            installPortalHoldShortcut: async (handlers) =>
              attachDesktopPortalGlobalShortcuts({
                appId: environment.appUserModelId,
                onActivated: () => handlers.onPressed(),
                onDeactivated: () => handlers.onReleased(),
              }),
          }
        : {}),
      sendLiveVoiceToggle: () => {
        void run(desktopWindow.sendLiveVoiceToggle);
      },
      onOrbSelect: (selection: DesktopJarvisOrbSelection) => {
        void run(desktopWindow.sendOrbSelection(selection));
      },
      revealMain: () => {
        void run(desktopWindow.activate);
      },
      quit: () => {
        void run(electronApp.quit);
      },
      setCloseToTrayEnabled: (enabled) => {
        void run(desktopWindow.setCloseToTrayEnabled(enabled));
      },
      onLiveVoiceState: (listener) => liveVoiceBridge.onState(listener),
      getLiveVoiceState: () =>
        liveVoiceBridge.getState() ?? { enabled: false, active: false, status: "idle" },
    });
    return DesktopJarvisShell.of({
      start: Effect.sync(runtime.start),
      stop: Effect.sync(runtime.stop),
    });
  }),
);
