// @effect-diagnostics nodeBuiltinImport:off - tests assert the helper profile lands under the injected directory on the real filesystem.
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import {
  JARVIS_GLOBAL_SHORTCUT,
  createDesktopJarvisRendererVoiceActions,
  createDesktopJarvisShell,
  desktopJarvisOverlaySurface,
  desktopJarvisOverlayHelperArgs,
  resolveDesktopJarvisOverlayBounds,
  resolveDesktopJarvisOverlayPosition,
  resolveDesktopJarvisTrayIconPath,
  shouldStartDesktopJarvisShell,
} from "./DesktopJarvisShell.ts";
import { desktopPushToTalkKeys, type DesktopPushToTalkHook } from "./DesktopPushToTalk.ts";

describe("DesktopJarvisShell", () => {
  it("routes the hotkey through the live voice surface", () => {
    const dispatch = vi.fn();
    const actions = createDesktopJarvisRendererVoiceActions(dispatch);

    actions.toggleLive();

    expect(dispatch.mock.calls).toEqual([["jarvis.live-voice-toggle"]]);
  });

  it("turns the one hotkey into a live conversation toggle when a key is configured", async () => {
    let onPressed: (() => void) | undefined;
    let onReleased: (() => void) | undefined;
    const sendLiveVoiceToggle = vi.fn();
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      installPortalHoldShortcut: async (handlers) => {
        onPressed = handlers.onPressed;
        onReleased = handlers.onReleased;
        return { close: async () => undefined };
      },
      sendLiveVoiceToggle,
      getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    onPressed?.();
    onReleased?.();
    onPressed?.();
    onReleased?.();

    expect(sendLiveVoiceToggle).toHaveBeenCalledTimes(2);
    shell.stop();
  });

  it("labels the tray with the real live conversation state", async () => {
    let onLiveState:
      | ((state: { enabled: boolean; active: boolean; status: string }) => void)
      | undefined;
    let trayTemplate: Electron.MenuItemConstructorOptions[] = [];
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: "/icon.png",
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "wayland",
      installPortalHoldShortcut: async () => null,
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
      getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
      onLiveVoiceState: (listener) => {
        onLiveState = listener as typeof onLiveState;
        return () => undefined;
      },
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(trayTemplate.map((item) => item.label)).toContain(
      "Start live conversation (Ctrl+Shift+J)",
    );

    onLiveState?.({ enabled: true, active: true, status: "live" });
    expect(trayTemplate.map((item) => item.label)).toContain(
      "End live conversation (Ctrl+Shift+J)",
    );
    shell.stop();
  });

  it("starts only for Jarvis distributions", () => {
    expect(shouldStartDesktopJarvisShell("official-jarvis")).toBe(true);
    expect(shouldStartDesktopJarvisShell("unified-jarvis")).toBe(true);
    expect(shouldStartDesktopJarvisShell("standalone")).toBe(false);
  });

  it("docks the orb middle-right of the active work area", () => {
    expect(
      resolveDesktopJarvisOverlayPosition({ x: 100, y: 50, width: 1_600, height: 900 }),
    ).toEqual({ x: 1636, y: 476 });
  });

  it("keeps the collapsed native window to the dot footprint", () => {
    const workArea = { x: 100, y: 50, width: 1_600, height: 900 };
    expect(resolveDesktopJarvisOverlayBounds(workArea, false)).toEqual({
      x: 1_636,
      y: 476,
      width: 48,
      height: 48,
    });
    expect(resolveDesktopJarvisOverlayBounds(workArea, true)).toEqual({
      x: 1_300,
      y: 280,
      width: 384,
      height: 440,
    });
  });

  it("keeps the dot anchored and panel within a small secondary display", () => {
    const area = { x: -600, y: 120, width: 500, height: 350 };
    const closed = resolveDesktopJarvisOverlayBounds(area, false);
    const opened = resolveDesktopJarvisOverlayBounds(area, true);
    expect(opened.x + opened.width).toBe(closed.x + closed.width);
    expect(opened.y + opened.height / 2).toBe(closed.y + closed.height / 2);
    expect(opened.y).toBeGreaterThanOrEqual(area.y);
    expect(opened.y + opened.height).toBeLessThanOrEqual(area.y + area.height);
  });

  it("resizes the native window when the dot opens and closes", () => {
    let consoleListener: ((event: unknown, level: number, message: string) => void) | undefined;
    const setBounds = vi.fn();
    const setFocusable = vi.fn();
    const overlay = {
      setFocusable,
      isDestroyed: vi.fn(() => false),
      setBounds,
      showInactive: vi.fn(),
      hide: vi.fn(),
      webContents: {
        executeJavaScript: vi.fn(() => Promise.resolve()),
        on: vi.fn((event: string, listener: typeof consoleListener) => {
          if (event === "console-message") consoleListener = listener;
        }),
        once: vi.fn(),
      },
    };
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      createOverlay: () => overlay as never,
      getOverlayWorkArea: () => ({ x: 100, y: 50, width: 1_600, height: 900 }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    expect(setBounds).toHaveBeenCalledWith({ x: 1_636, y: 476, width: 48, height: 48 }, false);
    consoleListener?.({}, 1, '[jarvis-orb] {"type":"expanded","expanded":true}');
    expect(setBounds).toHaveBeenLastCalledWith(
      { x: 1_300, y: 280, width: 384, height: 440 },
      false,
    );
    expect(setFocusable).toHaveBeenLastCalledWith(true);
    consoleListener?.({}, 1, '[jarvis-orb] {"type":"expanded","expanded":false}');
    expect(setFocusable).toHaveBeenLastCalledWith(false);
    expect(setBounds).toHaveBeenLastCalledWith({ x: 1_636, y: 476, width: 48, height: 48 }, false);
    shell.stop();
  });

  it("uses a positioned helper dock when native Wayland owns window placement", () => {
    expect(desktopJarvisOverlaySurface("linux", "wayland")).toBe("helper");
    expect(desktopJarvisOverlaySurface("linux", "x11")).toBe("window");
    expect(desktopJarvisOverlaySurface("win32", undefined)).toBe("window");
  });

  it("isolates the helper profile from the resident desktop process", () => {
    expect(desktopJarvisOverlayHelperArgs("/tmp/jarvis-overlay-1000")).toContain(
      "--user-data-dir=/tmp/jarvis-overlay-1000",
    );
  });

  it("uses explicit live tap when Wayland cannot provide a physical key-up edge", async () => {
    let currentTime = 0;
    let shortcutCallback: (() => void) | undefined;
    let trayTemplate: Electron.MenuItemConstructorOptions[] = [];
    const sendLiveVoiceToggle = vi.fn();
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
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
      sendLiveVoiceToggle,
      getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    shortcutCallback?.();
    expect(sendLiveVoiceToggle).toHaveBeenCalledTimes(1);
    expect(trayTemplate.map((item) => item.label)).toContain(
      "Start live conversation (Ctrl+Shift+J)",
    );

    // A held chord must never invent a second toggle after a quiet timeout.
    // Wayland only delivers one accelerator activation, so the next toggle
    // waits for the next deliberate tap.
    currentTime = 5_000;
    expect(sendLiveVoiceToggle).toHaveBeenCalledTimes(1);

    currentTime = 6_300;
    shortcutCallback?.();
    expect(sendLiveVoiceToggle).toHaveBeenCalledTimes(2);
    shell.stop();
  });

  it("promotes Linux Wayland to true hold when the portal reports Activated/Deactivated", async () => {
    const sendLiveVoiceToggle = vi.fn();
    let onPressed: (() => void) | undefined;
    let onReleased: (() => void) | undefined;
    const close = vi.fn(async () => undefined);
    const unregister = vi.fn();
    let trayTemplate: Electron.MenuItemConstructorOptions[] = [];
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
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
      sendLiveVoiceToggle,
      getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(onPressed).toBeDefined();
    expect(trayTemplate.map((item) => item.label)).toContain(
      "Start live conversation (Ctrl+Shift+J)",
    );
    expect(unregister).not.toHaveBeenCalled();

    onPressed?.();
    onPressed?.();
    expect(sendLiveVoiceToggle).toHaveBeenCalledTimes(2);
    onReleased?.();
    onReleased?.();
    // Release never toggles: live is a toggle, not a hold.
    expect(sendLiveVoiceToggle).toHaveBeenCalledTimes(2);

    shell.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps macOS on Electron tap-toggle and never loads the native hook", () => {
    vi.useFakeTimers();
    let currentTime = 0;
    const sendLiveVoiceToggle = vi.fn();
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
      displayName: "ARIS",
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
      sendLiveVoiceToggle,
      getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    expect(trayTemplate.map((item) => item.label)).toEqual([
      "Open ARIS",
      "Start live conversation (Command+Shift+J)",
      undefined,
      "Quit",
    ]);
    expect(hook.start).not.toHaveBeenCalled();
    expect(loadPushToTalkHook).not.toHaveBeenCalled();
    shortcutCallback?.();
    vi.advanceTimersByTime(1_200);
    currentTime += 1_200;
    shortcutCallback?.();
    expect(sendLiveVoiceToggle).toHaveBeenCalledTimes(2);
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
      displayName: "ARIS",
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
      sendLiveVoiceToggle: () => calls.push("live-toggle"),
      getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
      revealMain: () => calls.push("open"),
      quit: () => calls.push("quit"),
      setCloseToTrayEnabled: (enabled) => calls.push(`tray-close:${enabled}`),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    trayTemplate
      .find((item) => item.label === "Start live conversation (Ctrl+Shift+J)")
      ?.click?.({} as never, undefined, {} as never);
    trayTemplate
      .find((item) => item.label === "Open ARIS")
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

  it("creates the Wayland helper profile under the injected directory", () => {
    const profileDir = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jarvis-overlay-test-")),
      "profile",
    );
    try {
      const shell = createDesktopJarvisShell({
        displayName: "ARIS",
        iconPath: "/icon.png",
        platform: "linux",
        architecture: "x64",
        desktopSessionType: "wayland",
        installPortalHoldShortcut: async () => null,
        globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
        overlayProfileDir: profileDir,
        revealMain: vi.fn(),
        quit: vi.fn(),
      });
      shell.start();
      expect(NodeFS.existsSync(profileDir)).toBe(true);
      shell.stop();
    } finally {
      NodeFS.rmSync(profileDir, { recursive: true, force: true });
    }
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
        displayName: "ARIS",
        iconPath: null,
        platform,
        architecture: "x64",
        globalShortcut: { register, unregister: vi.fn() },
        loadPushToTalkHook: () => new Promise((resolve) => (resolveHook = resolve)),
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
      const sendLiveVoiceToggle = vi.fn();
      const shell = createDesktopJarvisShell({
        displayName: "ARIS",
        iconPath: null,
        platform,
        architecture: "x64",
        globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
        loadPushToTalkHook: async () => hook,
        createOverlay: () => overlay as never,
        sendLiveVoiceToggle,
        getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
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
      expect(sendLiveVoiceToggle).toHaveBeenCalledTimes(1);

      shell.stop();
      vi.useRealTimers();
    },
  );

  it("does not install the X11 native key hook in a Wayland session", async () => {
    const loadPushToTalkHook = vi.fn(async () => null);
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "wayland",
      installPortalHoldShortcut: async () => null,
      globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
      loadPushToTalkHook,
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
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "x11",
      installPortalHoldShortcut: async () => ({ close }),
      loadPushToTalkHook,
      globalShortcut: { register: vi.fn(() => true), unregister },
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
    const sendLiveVoiceToggle = vi.fn();
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
      loadPushToTalkHook: () => new Promise((resolve) => (resolveHook = resolve)),
      sendLiveVoiceToggle,
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
    expect(sendLiveVoiceToggle).not.toHaveBeenCalled();
  });

  it("keeps an explicit unavailable mode when shortcut registration fails", async () => {
    let trayTemplate: Electron.MenuItemConstructorOptions[] = [];
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: "/icon.png",
      platform: "linux",
      architecture: "x64",
      globalShortcut: {
        register: vi.fn(() => false),
        unregister: vi.fn(),
      },
      loadPushToTalkHook: async () => null,
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
    expect(trayTemplate.map((item) => item.label)).toContain(
      "Start live conversation (Ctrl+Shift+J)",
    );
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
      displayName: "ARIS",
      iconPath,
      platform: "linux",
      architecture: "x64",
      createTray: createTray as never,
      revealMain: vi.fn(),
      quit: vi.fn(),
      setCloseToTrayEnabled: (enabled) => closeToTray.push(enabled),
    });

    shell.start();

    if (iconPath === null) expect(createTray).not.toHaveBeenCalled();
    expect(closeToTray).toEqual([true]);
    shell.stop();
  });

  it("raises the orb when the live hotkey fires, not just the toggle", () => {
    const showInactive = vi.fn();
    const executeJavaScript = vi.fn(() => Promise.resolve());
    const sendLiveVoiceToggle = vi.fn();
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      installPortalHoldShortcut: async () => null,
      globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
      loadPushToTalkHook: async () => null,
      createOverlay: () =>
        ({
          isDestroyed: () => false,
          showInactive,
          hide: vi.fn(),
          setPosition: vi.fn(),
          webContents: {
            executeJavaScript,
            on: vi.fn(),
            once: (_event: string, callback: () => void) => callback(),
          },
        }) as never,
      getOverlayWorkArea: () => ({ x: 0, y: 0, width: 1_920, height: 1_080 }),
      sendLiveVoiceToggle,
      getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    const shownAtStart = showInactive.mock.calls.length;
    expect(shownAtStart).toBeGreaterThan(0);
    shell.talk();

    // The regression: the live branch used to send only the toggle and leave
    // the surface down. The orb must come up with the toggle.
    expect(sendLiveVoiceToggle).toHaveBeenCalledTimes(1);
    expect(showInactive.mock.calls.length).toBeGreaterThan(shownAtStart);
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("setLiveState"), true);
    shell.stop();
  });

  it("raises the Wayland helper orb on the live hotkey and pushes live state", () => {
    const sent: unknown[] = [];
    let helperStdout: ((line: string) => void) | undefined;
    const sendLiveVoiceToggle = vi.fn();
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "wayland",
      installPortalHoldShortcut: async () => null,
      overlayProfileDir: "/tmp/jarvis-orb-test-profile",
      spawnOverlayHelper: (_profileDir, onStdoutLine) => {
        helperStdout = onStdoutLine;
        return { send: (message: unknown) => sent.push(message), stop: vi.fn() };
      },
      sendLiveVoiceToggle,
      getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    expect(sent).toContainEqual({ type: "show" });
    const isShowMessage = (message: unknown): boolean =>
      typeof message === "object" &&
      message !== null &&
      (message as { readonly type?: unknown }).type === "show";
    const showCountAtStart = sent.filter(isShowMessage).length;
    shell.talk();
    expect(sendLiveVoiceToggle).toHaveBeenCalledTimes(1);
    expect(sent.filter(isShowMessage).length).toBe(showCountAtStart + 1);
    expect(sent).toContainEqual({
      type: "orb-state",
      state: { enabled: true, active: false, status: "idle" },
    });
    expect(helperStdout).toBeDefined();
    shell.stop();
  });

  it("pushes live-state changes to the orb surface", () => {
    let onLiveState:
      | ((state: { enabled: boolean; active: boolean; status: string }) => void)
      | undefined;
    const executeJavaScript = vi.fn(() => Promise.resolve());
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      createOverlay: () =>
        ({
          isDestroyed: () => false,
          showInactive: vi.fn(),
          hide: vi.fn(),
          webContents: {
            executeJavaScript,
            on: vi.fn(),
            once: (_event: string, callback: () => void) => callback(),
          },
        }) as never,
      sendLiveVoiceToggle: vi.fn(),
      getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
      onLiveVoiceState: (listener) => {
        onLiveState = listener as typeof onLiveState;
        return () => undefined;
      },
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    executeJavaScript.mockClear();
    onLiveState?.({ enabled: true, active: true, status: "live" });
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('setLiveState({"enabled":true,"active":true,"status":"live"})'),
      true,
    );
    shell.stop();
  });

  it("forwards the renderer catalog to the window orb and the helper orb", () => {
    const executeJavaScript = vi.fn(() => Promise.resolve());
    const windowShell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      createOverlay: () =>
        ({
          isDestroyed: () => false,
          showInactive: vi.fn(),
          hide: vi.fn(),
          webContents: {
            executeJavaScript,
            on: vi.fn(),
            once: (_event: string, callback: () => void) => callback(),
          },
        }) as never,
      revealMain: vi.fn(),
      quit: vi.fn(),
    });
    const catalog = {
      providers: [
        {
          instanceId: "claudeAgent",
          displayName: "Claude",
          driver: "claudeAgent",
          available: true,
          models: [{ slug: "sonnet", name: "Sonnet" }],
        },
      ],
      selected: null,
      pendingSelection: null,
      error: null,
    };
    windowShell.start();
    executeJavaScript.mockClear();
    windowShell.pushOrbCatalog(catalog);
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("setCatalog"), true);
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("claudeAgent"), true);
    windowShell.stop();

    const sent: unknown[] = [];
    const helperShell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "wayland",
      overlayProfileDir: "/tmp/jarvis-orb-test-profile",
      spawnOverlayHelper: () => ({ send: (message: unknown) => sent.push(message), stop: vi.fn() }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });
    helperShell.start();
    helperShell.pushOrbCatalog(catalog);
    expect(sent).toContainEqual({ type: "orb-catalog", catalog });
    helperShell.stop();
  });

  it("relays an orb picker selection from the window console bridge to the renderer", () => {
    let consoleListener: ((_event: unknown, _level: unknown, message: unknown) => void) | undefined;
    const seen: Array<{ instanceId: string; model: string }> = [];
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      createOverlay: () =>
        ({
          isDestroyed: () => false,
          showInactive: vi.fn(),
          hide: vi.fn(),
          webContents: {
            executeJavaScript: vi.fn(() => Promise.resolve()),
            on: vi.fn((event: string, listener: (...args: never[]) => void) => {
              if (event === "console-message") {
                consoleListener = listener as typeof consoleListener;
              }
            }),
            once: vi.fn(),
          },
        }) as never,
      onOrbSelect: (selection) => seen.push(selection),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    consoleListener?.({}, 1, '[jarvis-orb] {"type":"select","instanceId":"codex","model":"gpt-5"}');
    // Garbage and foreign logs never become selections.
    consoleListener?.({}, 1, "React devtools hook");
    consoleListener?.({}, 1, '[jarvis-orb] {"type":"select","instanceId":""}');
    consoleListener?.({}, 1, "[jarvis-orb] not json");
    expect(seen).toEqual([{ instanceId: "codex", model: "gpt-5" }]);
    shell.stop();
    consoleListener?.({}, 1, '[jarvis-orb] {"type":"select","instanceId":"codex","model":"gpt-5"}');
    expect(seen).toHaveLength(1);
  });

  it("relays an orb picker selection from helper stdout to the renderer", () => {
    let helperStdout: ((line: string) => void) | undefined;
    const seen: Array<{ instanceId: string; model: string }> = [];
    const stop = vi.fn();
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "wayland",
      overlayProfileDir: "/tmp/jarvis-orb-test-profile",
      spawnOverlayHelper: (_profileDir, onStdoutLine) => {
        helperStdout = onStdoutLine;
        return { send: vi.fn(), stop };
      },
      onOrbSelect: (selection) => seen.push(selection),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    helperStdout?.('[jarvis-orb] {"type":"select","instanceId":"opencode","model":"big"}');
    helperStdout?.("helper diagnostic noise");
    expect(seen).toEqual([{ instanceId: "opencode", model: "big" }]);
    shell.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("resizes the Wayland helper with the same compact bounds contract", () => {
    let helperStdout: ((line: string) => void) | undefined;
    const sent: unknown[] = [];
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      desktopSessionType: "wayland",
      overlayProfileDir: "/tmp/jarvis-orb-test-profile",
      spawnOverlayHelper: (_profileDir, onStdoutLine) => {
        helperStdout = onStdoutLine;
        return { send: (message) => sent.push(message), stop: vi.fn() };
      },
      getOverlayWorkArea: () => ({ x: 100, y: 50, width: 1_600, height: 900 }),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    helperStdout?.('[jarvis-orb] {"type":"expanded","expanded":true}');
    helperStdout?.('[jarvis-orb] {"type":"expanded","expanded":false}');
    expect(sent).toContainEqual({ type: "resize", expanded: true });
    expect(sent).toContainEqual({ type: "resize", expanded: false });
    shell.stop();
  });

  it("cleans up the window orb in order", async () => {
    const calls: string[] = [];
    const overlay = {
      isDestroyed: vi.fn(() => false),
      showInactive: vi.fn(),
      hide: vi.fn(() => calls.push("overlay-hide")),
      close: vi.fn(),
      webContents: {
        executeJavaScript: vi.fn(() => Promise.resolve()),
        on: vi.fn(),
        once: vi.fn(),
      },
    };
    const shell = createDesktopJarvisShell({
      displayName: "ARIS",
      iconPath: "/icon.png",
      platform: "linux",
      architecture: "x64",
      globalShortcut: {
        register: vi.fn(() => true),
        unregister: vi.fn(() => calls.push("shortcut-unregister")),
      },
      loadPushToTalkHook: async () => null,
      createTray: () =>
        ({
          setToolTip: vi.fn(),
          setContextMenu: vi.fn(),
          on: vi.fn(),
          destroy: vi.fn(() => calls.push("tray-destroy")),
        }) as never,
      buildTrayMenu: () => ({}) as never,
      createOverlay: () => overlay as never,
      revealMain: vi.fn(),
      quit: vi.fn(),
      setCloseToTrayEnabled: (enabled) => calls.push(`tray-close:${enabled}`),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    shell.stop();
    expect(calls).toContain("tray-close:false");
    expect(calls).toContain("shortcut-unregister");
    expect(calls).toContain("overlay-hide");
    expect(calls).toContain("tray-destroy");
  });
});
