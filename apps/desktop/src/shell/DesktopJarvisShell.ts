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

export const JARVIS_GLOBAL_SHORTCUT = "CommandOrControl+Shift+J";

export function shouldStartDesktopJarvisShell(
  distribution: DesktopEnvironment.DesktopDistribution,
): boolean {
  return distribution === "official-jarvis" || distribution === "unified-jarvis";
}

const VOICE_OVERLAY_WIDTH = 320;
const VOICE_OVERLAY_HEIGHT = 72;

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
  readonly createTray?: (icon: string | Electron.NativeImage) => Electron.Tray;
  readonly buildTrayMenu?: (template: Electron.MenuItemConstructorOptions[]) => Electron.Menu;
  readonly createOverlay?: () => Electron.BrowserWindow;
  readonly dispatchVoiceToggle: () => void;
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
  let started = false;
  let stopped = false;
  let overlayHideTimer: ReturnType<typeof setTimeout> | null = null;
  let removeVoiceStateListener: (() => void) | null = null;
  let overlayReady = false;
  let pendingOverlayState: DesktopJarvisVoiceState | null = null;

  const overlayDataUrl = (): string => {
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'"><style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}body{display:grid;place-items:center;color:#f5f5f0;font:600 13px system-ui,-apple-system,'Segoe UI',sans-serif}main{box-sizing:border-box;width:100%;height:100%;padding:0 18px;border:1px solid rgba(150,180,176,.55);border-radius:8px;background:radial-gradient(circle at 12% 50%,rgba(119,165,158,.2),transparent 42%),rgba(17,22,22,.95);display:flex;align-items:center;gap:10px;box-shadow:0 8px 30px rgba(0,0,0,.25)}i{width:8px;height:8px;border-radius:50%;background:#8db5ae;display:block;animation:glow 1.1s ease-out 2}span{letter-spacing:.1px}@keyframes glow{50%{box-shadow:0 0 0 5px rgba(141,181,174,.12)}to{box-shadow:none}}@media(prefers-reduced-motion:reduce){i{animation:none}}</style><main><i></i><span>Jarvis is listening</span></main>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  };

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
        void overlay.loadURL(overlayDataUrl());
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
    if (window === null || window.isDestroyed() || !overlayReady) return;
    const label =
      state.status === "capturing"
        ? "Jarvis is listening"
        : state.status === "transcribing"
          ? "Jarvis is understanding"
          : state.status === "speaking"
            ? "Jarvis is speaking"
            : state.status === "starting"
              ? "Preparing Jarvis voice"
              : state.status === "error" || state.status === "unavailable"
                ? "Jarvis voice needs attention"
                : "Jarvis is ready";
    try {
      void window.webContents.executeJavaScript(
        `document.querySelector('span').textContent=${JSON.stringify(label)}`,
        true,
      );
    } catch {
      // Overlay updates are best effort while its renderer is starting/closing.
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

  const open = (): void => {
    if (stopped) return;
    hideOverlay();
    input.revealMain();
  };

  const start = (): void => {
    if (started || stopped) return;
    started = true;
    input.setCloseToTrayEnabled?.(true);
    removeVoiceStateListener = input.onVoiceState?.(setOverlayState) ?? null;
    try {
      shortcutRegistered = shortcut.register(JARVIS_GLOBAL_SHORTCUT, talk);
    } catch {
      shortcutRegistered = false;
    }
    try {
      const icon = input.iconPath ?? Electron.nativeImage.createEmpty();
      tray = makeTray(icon);
      tray.setToolTip(input.displayName);
      tray.setContextMenu(
        buildTrayMenu([
          { label: "Open Jarvis", click: open },
          { label: "Talk to Jarvis", click: talk },
          { type: "separator" },
          { label: "Quit", click: input.quit },
        ]),
      );
      tray.on("click", open);
    } catch {
      tray = null;
    }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    removeVoiceStateListener?.();
    removeVoiceStateListener = null;
    input.setCloseToTrayEnabled?.(false);
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
    const icon = Option.getOrElse(iconPaths.png, () => null);
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
      revealMain: () => {
        void run(desktopWindow.revealOrCreateMain);
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
