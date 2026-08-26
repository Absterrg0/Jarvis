// @effect-diagnostics globalTimers:off

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import type { DesktopJarvisVoiceState } from "@t3tools/contracts";
import * as DesktopJarvisVoice from "../voice/DesktopJarvisVoice.ts";
import {
  desktopJarvisOverlayDataUrl,
  desktopJarvisOverlayStateScript,
} from "./DesktopJarvisOverlay.ts";
import { attachDesktopPushToTalkHook, type DesktopPushToTalkHook } from "./DesktopPushToTalk.ts";
import {
  attachDesktopPortalGlobalShortcuts,
  type DesktopPortalGlobalShortcutsHandle,
} from "./DesktopPortalGlobalShortcuts.ts";

export const JARVIS_GLOBAL_SHORTCUT = "CommandOrControl+Shift+J";
export const JARVIS_PORTAL_APP_ID = "com.abstergo.jarvis";

export function shouldStartDesktopJarvisShell(
  distribution: DesktopEnvironment.DesktopDistribution,
): boolean {
  return distribution === "official-jarvis" || distribution === "unified-jarvis";
}

export function createDesktopJarvisRendererVoiceActions(dispatch: (action: string) => void): {
  readonly toggle: () => void;
  readonly start: () => void;
  readonly release: () => void;
} {
  return {
    toggle: () => dispatch("jarvis.voice-toggle"),
    start: () => dispatch("jarvis.voice-start"),
    release: () => dispatch("jarvis.voice-release"),
  };
}

const VOICE_OVERLAY_WIDTH = 310;
const VOICE_OVERLAY_HEIGHT = 68;
const VOICE_OVERLAY_MARGIN = 28;
const VOICE_OVERLAY_STALL_MS = 20_000;
const TAP_SHORTCUT_REPEAT_GAP_MS = 1_200;

export function resolveDesktopJarvisOverlayPosition(
  workArea: Pick<Electron.Rectangle, "x" | "y" | "width" | "height">,
): { readonly x: number; readonly y: number } {
  return {
    x: Math.round(workArea.x + (workArea.width - VOICE_OVERLAY_WIDTH) / 2),
    y: workArea.y + workArea.height - VOICE_OVERLAY_HEIGHT - VOICE_OVERLAY_MARGIN,
  };
}

export type DesktopJarvisShortcutMode = "hold" | "tap" | "unavailable";

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
  readonly portalAppId?: string;
  readonly createTray?: (icon: string | Electron.NativeImage) => Electron.Tray;
  readonly buildTrayMenu?: (template: Electron.MenuItemConstructorOptions[]) => Electron.Menu;
  readonly createOverlay?: () => Electron.BrowserWindow;
  readonly dispatchVoiceToggle: () => void;
  readonly dispatchVoiceStart?: () => void;
  readonly dispatchVoiceRelease?: () => void;
  readonly revealMain: () => void;
  readonly quit: () => void;
  readonly setCloseToTrayEnabled?: (enabled: boolean) => void;
  readonly onVoiceState?: (listener: (state: DesktopJarvisVoiceState) => void) => () => void;
  readonly getVoiceState?: () => DesktopJarvisVoiceState;
  readonly prepareVoice?: () => Promise<unknown>;
  readonly now?: () => number;
  readonly getOverlayWorkArea?: () => Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;
}

/**
 * The Full Desktop shell owns the resident command surface. It deliberately
 * has no renderer of its own beyond a tiny status overlay: the already-loaded
 * main renderer remains the Jarvis orchestration owner.
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
  let shortcutRegistered = false;
  let shortcutMode: DesktopJarvisShortcutMode = "unavailable";
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
      shortcutMode = shortcutRegistered ? "tap" : "unavailable";
    } catch {
      shortcutRegistered = false;
      shortcutMode = "unavailable";
    }
    refreshTrayMenu();
  };
  let started = false;
  let stopped = false;
  let overlayHideTimer: ReturnType<typeof setTimeout> | null = null;
  let overlayStallTimer: ReturnType<typeof setTimeout> | null = null;
  let removeVoiceStateListener: (() => void) | null = null;
  let overlayReady = false;
  let pendingOverlayState: DesktopJarvisVoiceState | null = null;
  let lastTapShortcutActivationAt = Number.NEGATIVE_INFINITY;
  let holdActive = false;

  const ensureOverlay = (): Electron.BrowserWindow | null => {
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
        overlay.webContents.once("did-finish-load", () => {
          overlayReady = true;
          if (pendingOverlayState !== null) setOverlayState(pendingOverlayState);
        });
        void overlay.loadURL(desktopJarvisOverlayDataUrl());
      } catch {
        overlay = null;
      }
    } else {
      try {
        overlay = input.createOverlay();
        overlayReady = false;
        overlay.webContents.once("did-finish-load", () => {
          overlayReady = true;
          if (pendingOverlayState !== null) setOverlayState(pendingOverlayState);
        });
      } catch {
        overlay = null;
      }
    }
    return overlay;
  };

  const showOverlay = (): void => {
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

  const overlayInteraction = (): "hold" | "tap" => (shortcutMode === "hold" ? "hold" : "tap");

  const setOverlayState = (state: DesktopJarvisVoiceState): void => {
    pendingOverlayState = state;
    const window = overlay;
    if (overlayStallTimer !== null) {
      clearTimeout(overlayStallTimer);
      overlayStallTimer = null;
    }
    if (state.status === "starting") {
      overlayStallTimer = setTimeout(() => {
        overlayStallTimer = null;
        setOverlayState({
          status: "error",
          native: state.native,
          errorCode: "CAPTURE_START_TIMEOUT",
        });
      }, VOICE_OVERLAY_STALL_MS);
    }
    if (state.status === "ready" || state.status === "error" || state.status === "unavailable") {
      if (overlayHideTimer !== null) clearTimeout(overlayHideTimer);
      overlayHideTimer = setTimeout(
        () => {
          overlayHideTimer = null;
          hideOverlay();
        },
        state.status === "error" ? 1_500 : 900,
      );
    } else if (overlayHideTimer !== null) {
      clearTimeout(overlayHideTimer);
      overlayHideTimer = null;
    }
    if (window === null || window.isDestroyed() || !overlayReady) return;
    try {
      void window.webContents.executeJavaScript(
        desktopJarvisOverlayStateScript(state, { interaction: overlayInteraction() }),
        true,
      );
    } catch {
      // Overlay updates are best effort while its renderer is starting/closing.
    }
  };

  const hideOverlay = (): void => {
    if (overlayHideTimer !== null) {
      clearTimeout(overlayHideTimer);
      overlayHideTimer = null;
    }
    if (overlayStallTimer !== null) {
      clearTimeout(overlayStallTimer);
      overlayStallTimer = null;
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
    showOverlay();
    const current = input.getVoiceState?.();
    setOverlayState(
      current?.status === "capturing"
        ? current
        : { status: "starting", native: current?.native ?? true },
    );
    input.dispatchVoiceToggle();
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
    if (stopped || holdActive) return;
    holdActive = true;
    showOverlay();
    const current = input.getVoiceState?.();
    setOverlayState({ status: "starting", native: current?.native ?? true });
    (input.dispatchVoiceStart ?? input.dispatchVoiceToggle)();
  };

  const releaseTalk = (): void => {
    if (stopped || !holdActive) return;
    holdActive = false;
    (input.dispatchVoiceRelease ?? input.dispatchVoiceToggle)();
  };

  const refreshTrayMenu = (): void => {
    if (tray === null) return;
    const shortcutLabel = input.platform === "darwin" ? "Command+Shift+J" : "Ctrl+Shift+J";
    try {
      tray.setContextMenu(
        buildTrayMenu([
          { label: "Open Jarvis", click: open },
          {
            label:
              shortcutMode === "hold"
                ? "Hold Ctrl+Shift+J to talk"
                : shortcutMode === "tap"
                  ? `Tap ${shortcutLabel} to start or stop talking`
                  : "Talk to Jarvis",
            click: talk,
          },
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
    shortcutMode = "hold";
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
        if (shortcutMode === "hold") return;
      }
    }
    if (await installNativeHookHold(generation)) {
      if (stopped || generation !== pushToTalkLoadGeneration) return;
      if (shortcutMode === "hold") return;
    }
    if (stopped || generation !== pushToTalkLoadGeneration) return;
    // Honest fallback: Electron tap-toggle has no key-up. Install it only
    // after hold setup has failed so one physical chord can never change modes
    // between its down and up edges.
    installElectronTapShortcut();
  };

  const open = (): void => {
    if (stopped) return;
    hideOverlay();
    input.revealMain();
  };

  const start = (): void => {
    if (started || stopped) return;
    started = true;
    removeVoiceStateListener = input.onVoiceState?.(setOverlayState) ?? null;
    // Jarvis residency is a lifecycle guarantee. A tray is only an optional
    // navigation affordance and must not decide whether closing exits the app.
    input.setCloseToTrayEnabled?.(true);
    void input.prepareVoice?.().catch(() => undefined);
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
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    pushToTalkLoadGeneration += 1;
    removeVoiceStateListener?.();
    removeVoiceStateListener = null;
    input.setCloseToTrayEnabled?.(false);
    removePushToTalk?.();
    removePushToTalk = null;
    portalHold = null;
    clearElectronTapShortcut();
    hideOverlay();
    lastTapShortcutActivationAt = Number.NEGATIVE_INFINITY;
    holdActive = false;
    if (tray !== null) {
      try {
        tray.destroy();
      } catch {
        // Tray destruction is idempotent from the shell's perspective.
      }
      tray = null;
    }
  };

  return { start, stop, talk, open };
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
    const voice = yield* DesktopJarvisVoice.DesktopJarvisVoiceService;
    const iconPaths = yield* assets.iconPaths;
    const icon = resolveDesktopJarvisTrayIconPath(environment.platform, iconPaths);
    const context = yield* Effect.context<
      DesktopEnvironment.DesktopEnvironment | DesktopWindow.DesktopWindow | ElectronApp.ElectronApp
    >();
    const run = Effect.runPromiseWith(context);
    const dispatchVoiceAction = (action: string): void => {
      void run(desktopWindow.dispatchMainRendererAction(action));
    };
    const shortcutVoice = createDesktopJarvisRendererVoiceActions(dispatchVoiceAction);
    const runtime = createDesktopJarvisShell({
      displayName: environment.displayName,
      iconPath: icon,
      platform: environment.platform,
      architecture: environment.processArch as NodeJS.Architecture,
      portalAppId: environment.appUserModelId,
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
      dispatchVoiceToggle: shortcutVoice.toggle,
      dispatchVoiceStart: shortcutVoice.start,
      dispatchVoiceRelease: shortcutVoice.release,
      revealMain: () => {
        void run(desktopWindow.activate);
      },
      quit: () => {
        void run(electronApp.quit);
      },
      setCloseToTrayEnabled: (enabled) => {
        void run(desktopWindow.setCloseToTrayEnabled(enabled));
      },
      onVoiceState: voice.onState,
      getVoiceState: voice.getState,
      prepareVoice: voice.prepare,
    });
    return DesktopJarvisShell.of({
      start: Effect.sync(runtime.start),
      stop: Effect.sync(runtime.stop),
    });
  }),
);
