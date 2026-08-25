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

export const JARVIS_GLOBAL_SHORTCUT = "CommandOrControl+Shift+J";

export function shouldStartDesktopJarvisShell(
  distribution: DesktopEnvironment.DesktopDistribution,
): boolean {
  return distribution === "official-jarvis" || distribution === "unified-jarvis";
}

const VOICE_OVERLAY_WIDTH = 320;
const VOICE_OVERLAY_HEIGHT = 72;

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
  readonly globalShortcut?: Pick<typeof Electron.globalShortcut, "register" | "unregister">;
  readonly pushToTalkHook?: DesktopPushToTalkHook;
  readonly loadPushToTalkHook?: () => Promise<DesktopPushToTalkHook | null>;
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
  let tray: Electron.Tray | null = null;
  let overlay: Electron.BrowserWindow | null = null;
  let shortcutRegistered = false;
  let shortcutMode: DesktopJarvisShortcutMode = "unavailable";
  let removePushToTalk: (() => void) | null = null;
  let pushToTalkLoadGeneration = 0;
  let started = false;
  let stopped = false;
  let overlayHideTimer: ReturnType<typeof setTimeout> | null = null;
  let removeVoiceStateListener: (() => void) | null = null;
  let overlayReady = false;
  let pendingOverlayState: DesktopJarvisVoiceState | null = null;

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
      if (typeof window.showInactive === "function") window.showInactive();
      else window.show();
    } catch {
      // The overlay is best-effort UX and must never break the voice shortcut.
    }
  };

  const setOverlayState = (state: DesktopJarvisVoiceState): void => {
    pendingOverlayState = state;
    const window = overlay;
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
      void window.webContents.executeJavaScript(desktopJarvisOverlayStateScript(state), true);
    } catch {
      // Overlay updates are best effort while its renderer is starting/closing.
    }
  };

  const hideOverlay = (): void => {
    if (overlayHideTimer !== null) {
      clearTimeout(overlayHideTimer);
      overlayHideTimer = null;
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
    if (input.getVoiceState !== undefined) setOverlayState(input.getVoiceState());
    input.dispatchVoiceToggle();
  };

  const startTalk = (): void => {
    if (stopped) return;
    showOverlay();
    if (input.getVoiceState !== undefined) setOverlayState(input.getVoiceState());
    (input.dispatchVoiceStart ?? input.dispatchVoiceToggle)();
  };

  const releaseTalk = (): void => {
    if (stopped) return;
    (input.dispatchVoiceRelease ?? input.dispatchVoiceToggle)();
  };

  const refreshTrayMenu = (): void => {
    if (tray === null) return;
    try {
      tray.setContextMenu(
        buildTrayMenu([
          { label: "Open Jarvis", click: open },
          {
            label:
              shortcutMode === "hold"
                ? "Hold Ctrl+Shift+J to talk"
                : shortcutMode === "tap"
                  ? "Tap Ctrl+Shift+J to talk"
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

  const installPushToTalk = async (): Promise<void> => {
    const generation = pushToTalkLoadGeneration;
    let hook: DesktopPushToTalkHook | null = null;
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
      return;
    }
    if (hook === null) {
      if (!shortcutRegistered) {
        shortcutMode = "unavailable";
        refreshTrayMenu();
      }
      return;
    }
    try {
      const detach = attachDesktopPushToTalkHook({
        hook,
        onPressed: startTalk,
        onReleased: releaseTalk,
      });
      if (stopped || generation !== pushToTalkLoadGeneration) {
        detach();
        return;
      }
      removePushToTalk = detach;
      if (shortcutRegistered) {
        try {
          shortcut.unregister(JARVIS_GLOBAL_SHORTCUT);
        } catch {
          // The hook remains authoritative if Electron already released it.
        }
        shortcutRegistered = false;
      }
      shortcutMode = "hold";
      refreshTrayMenu();
    } catch {
      try {
        hook.stop();
      } catch {
        // Native hook setup is optional and must fail closed.
      }
      if (!shortcutRegistered) {
        shortcutMode = "unavailable";
        refreshTrayMenu();
      }
    }
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
    try {
      shortcutRegistered = shortcut.register(JARVIS_GLOBAL_SHORTCUT, talk);
      shortcutMode = shortcutRegistered ? "tap" : "unavailable";
    } catch {
      shortcutRegistered = false;
      shortcutMode = "unavailable";
    }
    try {
      if (input.iconPath === null) {
        input.setCloseToTrayEnabled?.(false);
      } else {
        const icon = input.iconPath;
        tray = makeTray(icon);
        tray.setToolTip(input.displayName);
        refreshTrayMenu();
        tray.on("click", open);
        input.setCloseToTrayEnabled?.(true);
      }
    } catch {
      tray = null;
      input.setCloseToTrayEnabled?.(false);
    }
    void installPushToTalk();
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
    if (shortcutRegistered) {
      try {
        shortcut.unregister(JARVIS_GLOBAL_SHORTCUT);
      } catch {
        // Electron can already have released shortcuts during app shutdown.
      }
      shortcutRegistered = false;
    }
    hideOverlay();
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
    const runtime = createDesktopJarvisShell({
      displayName: environment.displayName,
      iconPath: icon,
      dispatchVoiceToggle: () => {
        void run(desktopWindow.dispatchMainRendererAction("jarvis.voice-toggle"));
      },
      dispatchVoiceStart: () => {
        void run(desktopWindow.dispatchMainRendererAction("jarvis.voice-start"));
      },
      dispatchVoiceRelease: () => {
        void run(desktopWindow.dispatchMainRendererAction("jarvis.voice-release"));
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
      onVoiceState: voice.onState,
      getVoiceState: voice.getState,
    });
    return DesktopJarvisShell.of({
      start: Effect.sync(runtime.start),
      stop: Effect.sync(runtime.stop),
    });
  }),
);
