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
  DesktopCirceOrbCatalogSchema,
  type DesktopCirceLiveVoiceState,
  type DesktopCirceOrbCatalog,
  type DesktopCirceOrbSelection,
} from "@t3tools/contracts";
import { CIRCE_ORB_CATALOG_CHANNEL } from "../ipc/channels.ts";
import { createDesktopCirceLiveVoiceStateBridge } from "./DesktopCirceLiveVoiceState.ts";
import {
  DESKTOP_CIRCE_ORB_COLLAPSED_HEIGHT,
  DESKTOP_CIRCE_ORB_COLLAPSED_WIDTH,
  desktopCirceOrbCatalogScript,
  desktopCirceOrbStateScript,
  desktopCirceOverlayDataUrl,
  desktopCirceOverlayOrbCenter,
  parseDesktopCirceOverlayEvent,
  resolveDesktopCirceOverlayBounds,
  type DesktopCirceOverlayAnchor,
  type DesktopCirceOrbDragEvent,
} from "./DesktopCirceOverlay.ts";
export { resolveDesktopCirceOverlayBounds } from "./DesktopCirceOverlay.ts";
import { DESKTOP_CIRCE_OVERLAY_HELPER_FLAG } from "./DesktopCirceOverlayHelper.ts";
import { attachDesktopPushToTalkHook, type DesktopPushToTalkHook } from "./DesktopPushToTalk.ts";
import {
  attachDesktopPortalGlobalShortcuts,
  type DesktopPortalGlobalShortcutsHandle,
} from "./DesktopPortalGlobalShortcuts.ts";

export const CIRCE_GLOBAL_SHORTCUT = "CommandOrControl+Shift+J";

export function shouldStartDesktopCirceShell(
  distribution: DesktopEnvironment.DesktopDistribution,
): boolean {
  return distribution === "official-circe" || distribution === "unified-circe";
}

export function createDesktopCirceRendererVoiceActions(dispatch: (action: string) => void): {
  readonly toggleLive: () => void;
} {
  return {
    toggleLive: () => dispatch("circe.live-voice-toggle"),
  };
}

const TAP_SHORTCUT_REPEAT_GAP_MS = 1_200;

export function resolveDesktopCirceOverlayPosition(
  workArea: Pick<Electron.Rectangle, "x" | "y" | "width" | "height">,
): { readonly x: number; readonly y: number } {
  const bounds = resolveDesktopCirceOverlayBounds(workArea, false);
  return { x: bounds.x, y: bounds.y };
}

export type DesktopCirceOverlaySurface = "window" | "helper";

export function desktopCirceOverlaySurface(
  platform: NodeJS.Platform,
  desktopSessionType: string | undefined,
): DesktopCirceOverlaySurface {
  return platform === "linux" && desktopSessionType?.toLowerCase() === "wayland"
    ? "helper"
    : "window";
}

type DesktopCirceOverlayHelper = {
  readonly send: (message: unknown) => void;
  readonly stop: () => void;
  readonly onStdoutLine?: (listener: (line: string) => void) => () => void;
};

const DESKTOP_CIRCE_OVERLAY_HELPER_SHUTDOWN_GRACE_MS = 2_000;

function createDesktopCirceOverlayHelper(
  profileDir: string,
  onStdoutLine?: (line: string) => void,
): DesktopCirceOverlayHelper | null {
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
    const child = NodeChildProcess.spawn(executable, desktopCirceOverlayHelperArgs(userDataDir), {
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
        }, DESKTOP_CIRCE_OVERLAY_HELPER_SHUTDOWN_GRACE_MS);
        killTimer.unref?.();
      },
    };
  } catch {
    return null;
  }
}

export function desktopCirceOverlayHelperArgs(userDataDir: string): ReadonlyArray<string> {
  return [
    "--no-sandbox",
    "--ozone-platform=x11",
    `--user-data-dir=${userDataDir}`,
    DESKTOP_CIRCE_OVERLAY_HELPER_FLAG,
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

export function resolveDesktopCirceTrayIconPath(
  platform: NodeJS.Platform,
  iconPaths: DesktopAssets.DesktopIconPaths,
): string | null {
  const preferred = platform === "win32" ? iconPaths.ico : iconPaths.png;
  const fallback = platform === "win32" ? iconPaths.png : iconPaths.ico;
  return Option.getOrElse(preferred, () => Option.getOrElse(fallback, () => null));
}

export interface DesktopCirceShellRuntime {
  readonly start: () => void;
  readonly stop: () => void;
  readonly talk: () => void;
  readonly open: () => void;
  /** Renderer pushed a fresh provider catalog; forward it to the orb surface. */
  readonly pushOrbCatalog: (catalog: DesktopCirceOrbCatalog) => void;
}

export interface DesktopCirceShellInput {
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
  ) => DesktopCirceOverlayHelper | null;
  /**
   * Orb picker selection, relayed orb -> main -> renderer. The layer forwards
   * it to the main renderer, which validates it against the real catalog and
   * saves it through the ordinary settings API.
   */
  readonly onOrbSelect?: (selection: DesktopCirceOrbSelection) => void;
  /** Latest orb provider catalog supplied by the renderer, if any. */
  readonly getOrbCatalog?: () => DesktopCirceOrbCatalog | null;
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
  readonly onLiveVoiceState?: (listener: (state: DesktopCirceLiveVoiceState) => void) => () => void;
  readonly getLiveVoiceState?: () => DesktopCirceLiveVoiceState;
  readonly now?: () => number;
  readonly getOverlayWorkArea?: () => Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;
}

/**
 * The Full Desktop shell owns the resident command surface. It deliberately
 * has no renderer of its own beyond a tiny status overlay. The live
 * conversation owns the hotkey; the already-loaded renderer remains the
 * session owner.
 */
export function createDesktopCirceShell(input: DesktopCirceShellInput): DesktopCirceShellRuntime {
  const shortcut = input.globalShortcut ?? Electron.globalShortcut;
  const makeTray = input.createTray ?? ((icon) => new Electron.Tray(icon));
  const buildTrayMenu =
    input.buildTrayMenu ?? ((template) => Electron.Menu.buildFromTemplate(template));
  const now = input.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  let tray: Electron.Tray | null = null;
  let overlay: Electron.BrowserWindow | null = null;
  let overlayHelper: DesktopCirceOverlayHelper | null = null;
  const overlaySurface = desktopCirceOverlaySurface(input.platform, input.desktopSessionType);
  let shortcutRegistered = false;
  let removePushToTalk: (() => void) | null = null;
  let portalHold: DesktopPortalGlobalShortcutsHandle | null = null;
  let pushToTalkLoadGeneration = 0;

  const clearElectronTapShortcut = (): void => {
    if (!shortcutRegistered) return;
    try {
      shortcut.unregister(CIRCE_GLOBAL_SHORTCUT);
    } catch {
      // Electron may already have released the accelerator during teardown.
    }
    shortcutRegistered = false;
  };

  const installElectronTapShortcut = (): void => {
    if (stopped || shortcutRegistered) return;
    try {
      shortcutRegistered = shortcut.register(CIRCE_GLOBAL_SHORTCUT, activateTapShortcut);
    } catch {
      shortcutRegistered = false;
    }
    refreshTrayMenu();
  };
  let started = false;
  let stopped = false;
  let removeLiveVoiceStateListener: (() => void) | null = null;
  let liveVoiceState: DesktopCirceLiveVoiceState = {
    enabled: false,
    active: false,
    status: "idle",
  };
  // Set when a press was routed to live conversation, so the matching release
  // ends nothing: live is a toggle, not a hold.
  let liveToggleHeld = false;
  let overlayReady = false;
  let pendingOrbState: DesktopCirceLiveVoiceState | null = null;
  let pendingOrbCatalog: DesktopCirceOrbCatalog | null = null;
  let orbCatalog: DesktopCirceOrbCatalog | null = null;
  let lastTapShortcutActivationAt = Number.NEGATIVE_INFINITY;
  let overlayExpanded = false;
  // Orb centre the user dragged to, if any. Keeps the orb in place while the
  // panel expands and collapses around it.
  let overlayAnchor: DesktopCirceOverlayAnchor | null = null;
  let overlayDragStart: {
    readonly pointerX: number;
    readonly pointerY: number;
    readonly windowX: number;
    readonly windowY: number;
  } | null = null;

  /** The orb glow follows the real live session. */
  const resolveOrbLiveState = (): DesktopCirceLiveVoiceState => liveVoiceState;

  const handleOrbDrag = (event: DesktopCirceOrbDragEvent): void => {
    // The Wayland helper owns its own window and moves itself.
    if (overlaySurface === "helper") return;
    const window = overlay;
    if (window === null || window.isDestroyed()) return;
    if (event.phase === "start") {
      if (event.x === undefined || event.y === undefined) return;
      try {
        const bounds = window.getBounds();
        overlayDragStart = {
          pointerX: event.x,
          pointerY: event.y,
          windowX: bounds.x,
          windowY: bounds.y,
        };
      } catch {
        overlayDragStart = null;
      }
      return;
    }
    if (event.phase === "move") {
      if (overlayDragStart === null || event.x === undefined || event.y === undefined) return;
      try {
        window.setPosition(
          Math.round(overlayDragStart.windowX + (event.x - overlayDragStart.pointerX)),
          Math.round(overlayDragStart.windowY + (event.y - overlayDragStart.pointerY)),
          false,
        );
      } catch {
        // Display topology can change mid-drag; keep the last good position.
      }
      return;
    }
    overlayDragStart = null;
    try {
      if (typeof window.getBounds === "function") {
        overlayAnchor = desktopCirceOverlayOrbCenter(window.getBounds());
      }
    } catch {
      // Keep the previous anchor if the window cannot report its bounds.
    }
  };

  const handleOrbConsoleLine = (line: string): void => {
    if (stopped) return;
    const event = parseDesktopCirceOverlayEvent(line);
    if (event === null) return;
    if ("type" in event) {
      if (event.type === "expanded") setOverlayExpanded(event.expanded);
      else handleOrbDrag(event);
      return;
    }
    input.onOrbSelect?.(event);
  };

  const setOverlayExpanded = (expanded: boolean): void => {
    if (stopped || overlayExpanded === expanded) return;
    overlayExpanded = expanded;
    if (overlaySurface === "helper") {
      ensureOverlay();
      overlayHelper?.send({ type: "resize", expanded });
      return;
    }
    const window = overlay;
    if (window === null || window.isDestroyed()) return;
    try {
      const workArea =
        input.getOverlayWorkArea?.() ??
        Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()).workArea;
      const bounds = resolveDesktopCirceOverlayBounds(
        workArea,
        expanded,
        overlayAnchor ?? undefined,
      );
      window.setFocusable?.(expanded);
      if (expanded) window.focus?.();
      if (typeof window.setBounds === "function") window.setBounds(bounds, false);
      else if (typeof window.setPosition === "function")
        window.setPosition(bounds.x, bounds.y, false);
    } catch {
      // Display topology can change while the overlay is expanding.
    }
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
          overlayHelper = createDesktopCirceOverlayHelper(
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
          width: DESKTOP_CIRCE_ORB_COLLAPSED_WIDTH,
          height: DESKTOP_CIRCE_ORB_COLLAPSED_HEIGHT,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          frame: false,
          transparent: true,
          // A transparent overlay must not paint a rectangle shadow behind
          // the orb; the shadow reads as a dark background.
          hasShadow: false,
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
        void overlay.loadURL(desktopCirceOverlayDataUrl());
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
      if (typeof window.setBounds === "function") {
        const workArea =
          input.getOverlayWorkArea?.() ??
          Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()).workArea;
        window.setBounds(
          resolveDesktopCirceOverlayBounds(workArea, overlayExpanded, overlayAnchor ?? undefined),
          false,
        );
      } else if (typeof window.setPosition === "function") {
        const position = resolveDesktopCirceOverlayPosition(
          input.getOverlayWorkArea?.() ??
            Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()).workArea,
        );
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

  const pushOrbState = (state: DesktopCirceLiveVoiceState): void => {
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
      void window.webContents.executeJavaScript(desktopCirceOrbStateScript(state), true);
    } catch {
      // Overlay updates are best effort while its renderer is starting/closing.
    }
  };

  const pushOrbCatalogToSurface = (catalog: DesktopCirceOrbCatalog): void => {
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
      void window.webContents.executeJavaScript(desktopCirceOrbCatalogScript(catalog), true);
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
          { label: "Open Circe", click: open },
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

  const pushOrbCatalog = (catalog: DesktopCirceOrbCatalog): void => {
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
    // Circe residency is a lifecycle guarantee. A tray is only an optional
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
    overlayExpanded = false;
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

export class DesktopCirceShell extends Context.Service<
  DesktopCirceShell,
  {
    readonly start: Effect.Effect<void>;
    readonly stop: Effect.Effect<void>;
  }
>()("@t3tools/desktop/shell/DesktopCirceShell") {}

export const layer = Layer.effect(
  DesktopCirceShell,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const assets = yield* DesktopAssets.DesktopAssets;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const iconPaths = yield* assets.iconPaths;
    const icon = resolveDesktopCirceTrayIconPath(environment.platform, iconPaths);
    const context = yield* Effect.context<
      DesktopEnvironment.DesktopEnvironment | DesktopWindow.DesktopWindow | ElectronApp.ElectronApp
    >();
    const run = Effect.runPromiseWith(context);
    // One process-lifetime subscription: the shell layer is memoized once per
    // app build, and the bridge outlives every session it reports.
    const liveVoiceBridge = createDesktopCirceLiveVoiceStateBridge(Electron.ipcMain);
    const decodeOrbCatalog = Schema.decodeUnknownOption(DesktopCirceOrbCatalogSchema);
    let runtime: DesktopCirceShellRuntime | null = null;
    // Renderer-owned provider catalog for the orb picker. Invalid reports
    // leave the last known catalog alone; the orb never invents providers.
    Electron.ipcMain.on(CIRCE_ORB_CATALOG_CHANNEL, (_event: unknown, raw: unknown) => {
      const decoded = decodeOrbCatalog(raw);
      if (Option.isNone(decoded)) return;
      runtime?.pushOrbCatalog(decoded.value);
    });
    runtime = createDesktopCirceShell({
      displayName: environment.displayName,
      iconPath: icon,
      platform: environment.platform,
      architecture: environment.processArch as NodeJS.Architecture,
      overlayProfileDir: NodePath.join(Electron.app.getPath("userData"), "circe-overlay-profile"),
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
      onOrbSelect: (selection: DesktopCirceOrbSelection) => {
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
    return DesktopCirceShell.of({
      start: Effect.sync(runtime.start),
      stop: Effect.sync(runtime.stop),
    });
  }),
);
