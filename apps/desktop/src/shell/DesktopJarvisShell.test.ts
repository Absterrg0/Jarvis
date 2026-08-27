import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import {
  JARVIS_GLOBAL_SHORTCUT,
  createDesktopJarvisRendererVoiceActions,
  createDesktopJarvisShell,
  resolveDesktopJarvisOverlayPosition,
  resolveDesktopJarvisTrayIconPath,
  shouldStartDesktopJarvisShell,
} from "./DesktopJarvisShell.ts";
import { desktopPushToTalkKeys, type DesktopPushToTalkHook } from "./DesktopPushToTalk.ts";

describe("DesktopJarvisShell", () => {
  it("routes every shortcut edge through the renderer voice surface", () => {
    const dispatch = vi.fn();
    const actions = createDesktopJarvisRendererVoiceActions(dispatch);

    actions.start();
    actions.release();
    actions.toggle();

    expect(dispatch.mock.calls).toEqual([
      ["jarvis.voice-start"],
      ["jarvis.voice-release"],
      ["jarvis.voice-toggle"],
    ]);
  });

  it("releases the main voice immediately when a hold ends before start resolves", async () => {
    let onPressed: (() => void) | undefined;
    let onReleased: (() => void) | undefined;
    let resolveStart!: () => void;
    const startCapture = vi.fn(
      () =>
        new Promise<{ readonly accepted: boolean }>(
          (resolve) => (resolveStart = () => resolve({ accepted: true })),
        ),
    );
    const releaseCapture = vi.fn(async () => ({ accepted: true }));
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      installPortalHoldShortcut: async (handlers) => {
        onPressed = handlers.onPressed;
        onReleased = handlers.onReleased;
        return { close: async () => undefined };
      },
      dispatchVoiceToggle: vi.fn(),
      voice: { startCapture, releaseCapture } as never,
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    onPressed?.();
    onReleased?.();
    expect(startCapture).toHaveBeenCalledTimes(1);
    expect(releaseCapture).toHaveBeenCalledTimes(1);
    resolveStart();
    shell.stop();
  });

  it("queues one physical hold until a released capture reaches ready", async () => {
    let onPressed: (() => void) | undefined;
    let onReleased: (() => void) | undefined;
    let onVoiceState:
      | ((state: { readonly status: string; readonly native?: boolean }) => void)
      | undefined;
    const startCapture = vi.fn(async () => ({ accepted: true }));
    const releaseCapture = vi.fn(async () => ({ accepted: true }));
    const executeJavaScript = vi.fn(() => Promise.resolve());
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      installPortalHoldShortcut: async (handlers) => {
        onPressed = handlers.onPressed;
        onReleased = handlers.onReleased;
        return { close: async () => undefined };
      },
      createOverlay: () =>
        ({
          isDestroyed: () => false,
          showInactive: vi.fn(),
          hide: vi.fn(),
          webContents: {
            executeJavaScript,
            once: (_event: string, callback: () => void) => callback(),
          },
        }) as never,
      voice: { startCapture, releaseCapture } as never,
      onVoiceState: (listener) => {
        onVoiceState = listener as typeof onVoiceState;
        return () => undefined;
      },
      getVoiceState: () => ({ status: "ready", native: true }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    onPressed?.();
    onVoiceState?.({ status: "capturing", native: true });
    onReleased?.();
    onVoiceState?.({ status: "transcribing", native: true });
    onPressed?.();
    expect(startCapture).toHaveBeenCalledTimes(1);
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('"transcribing"'), true);

    // The worker's capture-result is followed by ready. The held B press now
    // owns a real capture rather than being sent into the still-decoding A.
    onVoiceState?.({ status: "ready", native: true });
    expect(startCapture).toHaveBeenCalledTimes(2);
    onReleased?.();
    expect(releaseCapture).toHaveBeenCalledTimes(2);
    shell.stop();
  });

  it("retires a next physical hold when it is released before ready", async () => {
    let onPressed: (() => void) | undefined;
    let onReleased: (() => void) | undefined;
    let onVoiceState:
      | ((state: { readonly status: string; readonly native?: boolean }) => void)
      | undefined;
    const startCapture = vi.fn(async () => ({ accepted: true }));
    const releaseCapture = vi.fn(async () => ({ accepted: true }));
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      installPortalHoldShortcut: async (handlers) => {
        onPressed = handlers.onPressed;
        onReleased = handlers.onReleased;
        return { close: async () => undefined };
      },
      voice: { startCapture, releaseCapture } as never,
      onVoiceState: (listener) => {
        onVoiceState = listener as typeof onVoiceState;
        return () => undefined;
      },
      getVoiceState: () => ({ status: "ready", native: true }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    onPressed?.();
    onVoiceState?.({ status: "capturing", native: true });
    onReleased?.();
    onVoiceState?.({ status: "transcribing", native: true });
    onPressed?.();
    onReleased?.();
    onVoiceState?.({ status: "ready", native: true });

    expect(startCapture).toHaveBeenCalledTimes(1);
    expect(releaseCapture).toHaveBeenCalledTimes(1);
    shell.stop();
  });

  it("allows another hold after a terminal state reconciles a lost release", async () => {
    let onPressed: (() => void) | undefined;
    let voiceStateListener: ((state: { readonly status: string }) => void) | undefined;
    const startCapture = vi.fn(async () => ({ accepted: true }));
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      installPortalHoldShortcut: async (handlers) => {
        onPressed = handlers.onPressed;
        return { close: async () => undefined };
      },
      dispatchVoiceToggle: vi.fn(),
      voice: { startCapture, releaseCapture: vi.fn(async () => ({ accepted: true })) } as never,
      onVoiceState: (listener) => {
        voiceStateListener = listener as typeof voiceStateListener;
        return () => undefined;
      },
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    onPressed?.();
    voiceStateListener?.({ status: "ready" });
    onPressed?.();
    expect(startCapture).toHaveBeenCalledTimes(2);
    shell.stop();
  });

  it("routes measured audio levels to the overlay and resets them at terminal state", () => {
    let levelListener: ((level: number) => void) | undefined;
    let stateListener:
      | ((state: { readonly status: string; readonly native?: boolean }) => void)
      | undefined;
    const executeJavaScript = vi.fn(() => Promise.resolve());
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "darwin",
      architecture: "arm64",
      createOverlay: () =>
        ({
          isDestroyed: () => false,
          showInactive: vi.fn(),
          hide: vi.fn(),
          webContents: {
            executeJavaScript,
            once: (_event: string, callback: () => void) => callback(),
          },
        }) as never,
      dispatchVoiceToggle: vi.fn(),
      onVoiceLevel: (listener) => {
        levelListener = listener;
        return () => undefined;
      },
      onVoiceState: (listener) => {
        stateListener = listener as typeof stateListener;
        return () => undefined;
      },
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    shell.talk();
    levelListener?.(0.6);
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("setLevel(0.6)"), true);
    stateListener?.({ status: "ready", native: true });
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("setLevel(0)"), true);
    shell.stop();
  });

  it("starts only for Jarvis distributions", () => {
    expect(shouldStartDesktopJarvisShell("official-jarvis")).toBe(true);
    expect(shouldStartDesktopJarvisShell("unified-jarvis")).toBe(true);
    expect(shouldStartDesktopJarvisShell("standalone")).toBe(false);
  });

  it("centers the voice dock above the bottom of the active work area", () => {
    expect(
      resolveDesktopJarvisOverlayPosition({ x: 100, y: 50, width: 1_600, height: 900 }),
    ).toEqual({ x: 745, y: 854 });
  });

  it("routes the shortcut and Talk action to voice without revealing the workspace", async () => {
    const calls: string[] = [];
    let shortcutCallback: (() => void) | undefined;
    let voiceStateListener: ((state: { status: string }) => void) | undefined;
    let trayTemplate: Electron.MenuItemConstructorOptions[] = [];
    const tray = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(() => calls.push("tray-destroy")),
    };
    const overlay = {
      isDestroyed: vi.fn(() => false),
      showInactive: vi.fn(() => calls.push("overlay-show")),
      hide: vi.fn(() => calls.push("overlay-hide")),
      close: vi.fn(),
      webContents: { executeJavaScript: vi.fn(() => Promise.resolve()), once: vi.fn() },
    };
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: "/icon.png",
      platform: "linux",
      architecture: "x64",
      globalShortcut: {
        register: vi.fn((_accelerator, callback) => {
          shortcutCallback = callback;
          return true;
        }),
        unregister: vi.fn((accelerator) => calls.push(`unregister:${accelerator}`)),
      },
      loadPushToTalkHook: async () => null,
      createTray: () => tray as never,
      buildTrayMenu: (template) => {
        trayTemplate = template;
        return {} as never;
      },
      createOverlay: () => overlay as never,
      dispatchVoiceToggle: () => calls.push("voice-toggle"),
      revealMain: () => calls.push("reveal"),
      quit: () => calls.push("quit"),
      setCloseToTrayEnabled: (enabled) => calls.push(`tray-close:${enabled}`),
      onVoiceState: (listener) => {
        voiceStateListener = listener as typeof voiceStateListener;
        return () => undefined;
      },
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(shortcutCallback).toBeDefined();
    expect(trayTemplate.map((item) => item.label)).toEqual([
      "Open Jarvis",
      "Tap Ctrl+Shift+J to start or stop talking",
      undefined,
      "Quit",
    ]);

    shortcutCallback?.();
    trayTemplate
      .find((item) => item.label === "Tap Ctrl+Shift+J to start or stop talking")
      ?.click?.({} as never, undefined, {} as never);
    expect(calls.filter((call) => call === "voice-toggle")).toHaveLength(2);
    expect(calls).not.toContain("reveal");
    voiceStateListener?.({ status: "capturing" });
    expect(overlay.hide).not.toHaveBeenCalled();
    shell.stop();
  });

  it("uses explicit tap-to-talk when Wayland cannot provide a physical key-up edge", async () => {
    let currentTime = 0;
    let shortcutCallback: (() => void) | undefined;
    let trayTemplate: Electron.MenuItemConstructorOptions[] = [];
    const dispatchVoiceToggle = vi.fn();
    const dispatchVoiceRelease = vi.fn();
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: "/icon.png",
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "wayland",
      // Portal unavailable → honest Electron tap, never a quiet-timeout "hold".
      installPortalHoldShortcut: async () => null,
      now: () => currentTime,
      globalShortcut: {
        register: vi.fn((_accelerator, callback) => {
          shortcutCallback = callback;
          return true;
        }),
        unregister: vi.fn(),
      },
      createTray: () =>
        ({
          setToolTip: vi.fn(),
          setContextMenu: vi.fn(),
          on: vi.fn(),
          destroy: vi.fn(),
        }) as never,
      buildTrayMenu: (template) => {
        trayTemplate = template;
        return {} as never;
      },
      dispatchVoiceToggle,
      dispatchVoiceRelease,
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    shortcutCallback?.();
    expect(dispatchVoiceToggle).toHaveBeenCalledTimes(1);
    expect(trayTemplate.map((item) => item.label)).toContain(
      "Tap Ctrl+Shift+J to start or stop talking",
    );

    // A held chord must never invent a release after a quiet timeout. Wayland
    // only delivers one accelerator activation, so capture stays open until the
    // next deliberate tap.
    currentTime = 5_000;
    expect(dispatchVoiceToggle).toHaveBeenCalledTimes(1);
    expect(dispatchVoiceRelease).not.toHaveBeenCalled();

    currentTime = 6_300;
    shortcutCallback?.();
    expect(dispatchVoiceToggle).toHaveBeenCalledTimes(2);
    shell.stop();
  });

  it("promotes Linux Wayland to true hold when the portal reports Activated/Deactivated", async () => {
    const calls: string[] = [];
    let onPressed: (() => void) | undefined;
    let onReleased: (() => void) | undefined;
    const close = vi.fn(async () => undefined);
    const unregister = vi.fn();
    let trayTemplate: Electron.MenuItemConstructorOptions[] = [];
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: "/icon.png",
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "wayland",
      installPortalHoldShortcut: async (handlers) => {
        onPressed = handlers.onPressed;
        onReleased = handlers.onReleased;
        return { close };
      },
      loadPushToTalkHook: async () => {
        throw new Error("uiohook must not load on Wayland when portal hold is available");
      },
      globalShortcut: {
        register: vi.fn(() => true),
        unregister,
      },
      createTray: () =>
        ({
          setToolTip: vi.fn(),
          setContextMenu: vi.fn(),
          on: vi.fn(),
          destroy: vi.fn(),
        }) as never,
      buildTrayMenu: (template) => {
        trayTemplate = template;
        return {} as never;
      },
      dispatchVoiceToggle: () => calls.push("voice-toggle"),
      dispatchVoiceStart: () => calls.push("voice-start"),
      dispatchVoiceRelease: () => calls.push("voice-release"),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(onPressed).toBeDefined();
    expect(trayTemplate.map((item) => item.label)).toContain("Hold Ctrl+Shift+J to talk");
    expect(unregister).not.toHaveBeenCalled();

    onPressed?.();
    onPressed?.();
    expect(calls).toEqual(["voice-start"]);
    onReleased?.();
    onReleased?.();
    expect(calls).toEqual(["voice-start", "voice-release"]);

    shell.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps macOS on Electron tap-toggle and never loads the native hook", () => {
    vi.useFakeTimers();
    let currentTime = 0;
    const calls: string[] = [];
    let shortcutCallback: (() => void) | undefined;
    let trayTemplate: Electron.MenuItemConstructorOptions[] = [];
    const hook: DesktopPushToTalkHook = {
      on: vi.fn(),
      removeListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const loadPushToTalkHook = vi.fn(async () => hook);
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: "/icon.png",
      platform: "darwin",
      architecture: "arm64",
      pushToTalkHook: hook,
      loadPushToTalkHook,
      now: () => currentTime,
      globalShortcut: {
        register: vi.fn((_accelerator, callback) => {
          shortcutCallback = callback;
          return true;
        }),
        unregister: vi.fn(),
      },
      createTray: () =>
        ({
          setToolTip: vi.fn(),
          setContextMenu: vi.fn(),
          on: vi.fn(),
          destroy: vi.fn(),
        }) as never,
      buildTrayMenu: (template) => {
        trayTemplate = template;
        return {} as never;
      },
      dispatchVoiceToggle: () => calls.push("voice-toggle"),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    expect(trayTemplate.map((item) => item.label)).toEqual([
      "Open Jarvis",
      "Tap Command+Shift+J to start or stop talking",
      undefined,
      "Quit",
    ]);
    expect(hook.start).not.toHaveBeenCalled();
    expect(loadPushToTalkHook).not.toHaveBeenCalled();
    shortcutCallback?.();
    vi.advanceTimersByTime(1_200);
    currentTime += 1_200;
    shortcutCallback?.();
    expect(calls).toEqual(["voice-toggle", "voice-toggle"]);
    shell.stop();
    vi.useRealTimers();
  });

  it("keeps tray open and quit actions separate, then cleans up in order", async () => {
    const calls: string[] = [];
    let trayTemplate: Electron.MenuItemConstructorOptions[] = [];
    const tray = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(() => calls.push("tray-destroy")),
    };
    const overlay = {
      isDestroyed: vi.fn(() => false),
      showInactive: vi.fn(),
      hide: vi.fn(() => calls.push("overlay-hide")),
      close: vi.fn(),
      webContents: { executeJavaScript: vi.fn(() => Promise.resolve()), once: vi.fn() },
    };
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: "/icon.png",
      platform: "linux",
      architecture: "x64",
      globalShortcut: {
        register: vi.fn(() => true),
        unregister: vi.fn(() => calls.push("shortcut-unregister")),
      },
      loadPushToTalkHook: async () => null,
      createTray: () => tray as never,
      buildTrayMenu: (template) => {
        trayTemplate = template;
        return {} as never;
      },
      createOverlay: () => overlay as never,
      dispatchVoiceToggle: () => calls.push("voice-toggle"),
      revealMain: () => calls.push("open"),
      quit: () => calls.push("quit"),
      setCloseToTrayEnabled: (enabled) => calls.push(`tray-close:${enabled}`),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    trayTemplate
      .find((item) => item.label === "Tap Ctrl+Shift+J to start or stop talking")
      ?.click?.({} as never, undefined, {} as never);
    trayTemplate
      .find((item) => item.label === "Open Jarvis")
      ?.click?.({} as never, undefined, {} as never);
    trayTemplate
      .find((item) => item.label === "Quit")
      ?.click?.({} as never, undefined, {} as never);
    expect(calls).toContain("open");
    expect(calls).toContain("quit");

    shell.stop();
    expect(calls.slice(-4)).toEqual([
      "tray-close:false",
      "shortcut-unregister",
      "overlay-hide",
      "tray-destroy",
    ]);
    expect(JARVIS_GLOBAL_SHORTCUT).toBe("CommandOrControl+Shift+J");
  });

  it("keeps a long capture visible and only hides after ready", () => {
    vi.useFakeTimers();
    let loaded: (() => void) | undefined;
    let stateListener: ((state: { status: string }) => void) | undefined;
    const overlay = {
      isDestroyed: vi.fn(() => false),
      showInactive: vi.fn(),
      hide: vi.fn(),
      webContents: {
        executeJavaScript: vi.fn(() => Promise.resolve()),
        once: vi.fn((_event: string, listener: () => void) => {
          loaded = listener;
        }),
      },
    };
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: "/icon.png",
      platform: "linux",
      architecture: "x64",
      globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
      loadPushToTalkHook: async () => null,
      createTray: () =>
        ({
          setToolTip: vi.fn(),
          setContextMenu: vi.fn(),
          on: vi.fn(),
          destroy: vi.fn(),
        }) as never,
      buildTrayMenu: () => ({}) as never,
      createOverlay: () => overlay as never,
      dispatchVoiceToggle: vi.fn(),
      revealMain: vi.fn(),
      quit: vi.fn(),
      onVoiceState: (listener) => {
        stateListener = listener as typeof stateListener;
        return () => undefined;
      },
      getVoiceState: () => ({ status: "capturing", native: true }),
    });
    shell.start();
    shell.talk();
    expect(overlay.showInactive).toHaveBeenCalled();
    loaded?.();
    stateListener?.({ status: "transcribing" });
    vi.advanceTimersByTime(10_000);
    expect(overlay.hide).not.toHaveBeenCalled();
    stateListener?.({ status: "ready" });
    vi.advanceTimersByTime(899);
    expect(overlay.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(overlay.hide).toHaveBeenCalledTimes(1);
    shell.stop();
    vi.useRealTimers();
  });

  it("hides a settled overlay even when its renderer never finishes loading", () => {
    vi.useFakeTimers();
    const overlay = {
      isDestroyed: vi.fn(() => false),
      showInactive: vi.fn(),
      hide: vi.fn(),
      webContents: {
        executeJavaScript: vi.fn(() => Promise.resolve()),
        once: vi.fn(),
      },
    };
    let stateListener: ((state: { status: string }) => void) | undefined;
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: "/icon.png",
      platform: "linux",
      architecture: "x64",
      globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
      loadPushToTalkHook: async () => null,
      createTray: () =>
        ({
          setToolTip: vi.fn(),
          setContextMenu: vi.fn(),
          on: vi.fn(),
          destroy: vi.fn(),
        }) as never,
      buildTrayMenu: () => ({}) as never,
      createOverlay: () => overlay as never,
      dispatchVoiceToggle: vi.fn(),
      revealMain: vi.fn(),
      quit: vi.fn(),
      onVoiceState: (listener) => {
        stateListener = listener as typeof stateListener;
        return () => undefined;
      },
    });

    shell.start();
    shell.talk();
    stateListener?.({ status: "ready" });
    vi.advanceTimersByTime(899);
    expect(overlay.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(overlay.hide).toHaveBeenCalledTimes(1);
    shell.stop();
    vi.useRealTimers();
  });

  it.each(["linux", "win32"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "does not expose tap mode while the %s hold path is still loading",
    async (platform) => {
      let resolveHook: ((hook: DesktopPushToTalkHook) => void) | undefined;
      const hook: DesktopPushToTalkHook = {
        on: vi.fn(),
        removeListener: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      const register = vi.fn(() => true);
      const shell = createDesktopJarvisShell({
        displayName: "Jarvis",
        iconPath: null,
        platform,
        architecture: "x64",
        globalShortcut: { register, unregister: vi.fn() },
        loadPushToTalkHook: () => new Promise((resolve) => (resolveHook = resolve)),
        dispatchVoiceToggle: vi.fn(),
        dispatchVoiceStart: vi.fn(),
        dispatchVoiceRelease: vi.fn(),
        revealMain: vi.fn(),
        quit: vi.fn(),
      });

      shell.start();
      expect(register).not.toHaveBeenCalled();
      resolveHook?.(hook);
      await Promise.resolve();
      await Promise.resolve();
      expect(hook.start).toHaveBeenCalledTimes(1);
      expect(register).not.toHaveBeenCalled();
      shell.stop();
    },
  );

  it.each(["linux", "win32"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "keeps the overlay visible while a %s hold is still starting",
    async (platform) => {
      vi.useFakeTimers();
      const listeners = new Map<string, (event: never) => void>();
      const hook: DesktopPushToTalkHook = {
        on: vi.fn((type, listener) => listeners.set(type, listener as (event: never) => void)),
        removeListener: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      const overlay = {
        isDestroyed: vi.fn(() => false),
        showInactive: vi.fn(),
        hide: vi.fn(),
        webContents: { executeJavaScript: vi.fn(() => Promise.resolve()), once: vi.fn() },
      };
      const shell = createDesktopJarvisShell({
        displayName: "Jarvis",
        iconPath: null,
        platform,
        architecture: "x64",
        globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
        loadPushToTalkHook: async () => hook,
        createOverlay: () => overlay as never,
        dispatchVoiceToggle: vi.fn(),
        dispatchVoiceStart: vi.fn(),
        dispatchVoiceRelease: vi.fn(),
        getVoiceState: () => ({ status: "ready", native: true }),
        revealMain: vi.fn(),
        quit: vi.fn(),
      });

      shell.start();
      await Promise.resolve();
      await Promise.resolve();
      listeners.get("keydown")?.({
        keycode: desktopPushToTalkKeys.j,
        ctrlKey: true,
        shiftKey: true,
      } as never);
      vi.advanceTimersByTime(950);
      expect(overlay.hide).not.toHaveBeenCalled();

      shell.stop();
      vi.useRealTimers();
    },
  );

  it("does not install the X11 native key hook in a Wayland session", async () => {
    const loadPushToTalkHook = vi.fn(async () => null);
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "wayland",
      installPortalHoldShortcut: async () => null,
      globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
      loadPushToTalkHook,
      dispatchVoiceToggle: vi.fn(),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    expect(loadPushToTalkHook).not.toHaveBeenCalled();
    shell.stop();
  });

  it("prefers the Linux portal hold path over the X11 native key hook", async () => {
    const loadPushToTalkHook = vi.fn(async () => {
      throw new Error("native hook should stay cold when portal hold wins");
    });
    const close = vi.fn(async () => undefined);
    const unregister = vi.fn();
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "x11",
      installPortalHoldShortcut: async () => ({ close }),
      loadPushToTalkHook,
      globalShortcut: { register: vi.fn(() => true), unregister },
      dispatchVoiceToggle: vi.fn(),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(loadPushToTalkHook).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    shell.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not let a late hook load revive a disposed shell", async () => {
    let resolveHook: ((hook: DesktopPushToTalkHook) => void) | undefined;
    const hook: DesktopPushToTalkHook = {
      on: vi.fn(),
      removeListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const dispatchVoiceToggle = vi.fn();
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
      loadPushToTalkHook: () => new Promise((resolve) => (resolveHook = resolve)),
      dispatchVoiceToggle,
      revealMain: vi.fn(),
      quit: vi.fn(),
    });
    shell.start();
    shell.stop();
    resolveHook?.(hook);
    await Promise.resolve();
    await Promise.resolve();
    expect(hook.start).not.toHaveBeenCalled();
    expect(hook.stop).toHaveBeenCalledTimes(1);
    expect(dispatchVoiceToggle).not.toHaveBeenCalled();
  });

  it("keeps an explicit unavailable mode when shortcut registration fails", async () => {
    let trayTemplate: Electron.MenuItemConstructorOptions[] = [];
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: "/icon.png",
      platform: "linux",
      architecture: "x64",
      globalShortcut: {
        register: vi.fn(() => false),
        unregister: vi.fn(),
      },
      loadPushToTalkHook: async () => null,
      dispatchVoiceToggle: vi.fn(),
      revealMain: vi.fn(),
      quit: vi.fn(),
      createTray: () =>
        ({ setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() }) as never,
      buildTrayMenu: (template) => {
        trayTemplate = template;
        return {} as never;
      },
    });
    shell.start();
    await Promise.resolve();
    expect(trayTemplate.map((item) => item.label)).toContain("Talk to Jarvis");
    shell.stop();
  });

  it("prefers the Windows ICO for the resident tray", () => {
    expect(
      resolveDesktopJarvisTrayIconPath("win32", {
        ico: Option.some("/jarvis.ico"),
        icns: Option.some("/jarvis.icns"),
        png: Option.some("/jarvis.png"),
      }),
    ).toBe("/jarvis.ico");
  });

  it.each([
    { name: "no tray asset is available", iconPath: null as string | null },
    { name: "the desktop rejects tray creation", iconPath: "/icon.png" as string | null },
  ])("keeps Jarvis resident when $name", ({ iconPath }) => {
    const createTray =
      iconPath === null
        ? vi.fn()
        : () => {
            throw new Error("tray backend unavailable");
          };
    const closeToTray: boolean[] = [];
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath,
      platform: "linux",
      architecture: "x64",
      createTray: createTray as never,
      dispatchVoiceToggle: vi.fn(),
      revealMain: vi.fn(),
      quit: vi.fn(),
      setCloseToTrayEnabled: (enabled) => closeToTray.push(enabled),
    });

    shell.start();

    if (iconPath === null) expect(createTray).not.toHaveBeenCalled();
    expect(closeToTray).toEqual([true]);
    shell.stop();
  });
});
