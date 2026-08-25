import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import {
  JARVIS_GLOBAL_SHORTCUT,
  createDesktopJarvisShell,
  resolveDesktopJarvisTrayIconPath,
  shouldStartDesktopJarvisShell,
} from "./DesktopJarvisShell.ts";
import {
  desktopJarvisOverlayDataUrl,
  desktopJarvisOverlayPresentation,
  desktopJarvisOverlayStateScript,
} from "./DesktopJarvisOverlay.ts";
import { desktopPushToTalkKeys, type DesktopPushToTalkHook } from "./DesktopPushToTalk.ts";

describe("DesktopJarvisShell", () => {
  it("maps every voice state to a distinct fluid surface profile", () => {
    const profiles = [
      ["starting", "Preparing Jarvis voice", true],
      ["capturing", "Listening · press again to send", true],
      ["transcribing", "Jarvis is understanding", true],
      ["speaking", "Jarvis is speaking", true],
      ["ready", "Jarvis is ready", false],
      ["error", "Jarvis voice needs attention", false],
      ["unavailable", "Jarvis voice is unavailable", false],
    ] as const;

    for (const [status, label, animated] of profiles) {
      const profile = desktopJarvisOverlayPresentation({ status, native: true });
      expect(profile.label).toBe(label);
      expect(profile.animated).toBe(animated);
      expect(profile.settled).toBe(!animated);
      expect(profile.accent).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(desktopJarvisOverlayStateScript({ status: "speaking", native: true })).toContain(
      'setState("speaking")',
    );
  });

  it("ships a local WebGL canvas renderer with bounded motion and safe fallbacks", () => {
    const html = decodeURIComponent(
      desktopJarvisOverlayDataUrl().replace(/^data:text\/html;charset=utf-8,/, ""),
    );
    const serializedProfiles = html.match(/const profiles = (\{.*?\});/);
    expect(serializedProfiles).not.toBeNull();
    const rendererStatuses = Object.keys(JSON.parse(serializedProfiles?.[1] ?? "{}"));
    expect(rendererStatuses.sort()).toEqual(
      ["starting", "capturing", "transcribing", "speaking", "ready", "error", "unavailable"].sort(),
    );
    expect(html).toContain("<canvas");
    expect(html).toContain("requestAnimationFrame");
    expect(html).toContain("cancelAnimationFrame");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain("visibilitychange");
    expect(html).toContain("contextlost");
    expect(html).toContain("contextLost");
    expect(html).toContain('addEventListener("webglcontextlost"');
    expect(html).toContain('addEventListener("webglcontextrestored"');
    expect(html).toContain('removeEventListener("webglcontextlost"');
    expect(html).toContain('removeEventListener("webglcontextrestored"');
    expect(html).toContain("time - lastFrame < frameInterval");
    expect(html).toContain("if (isAnimated()) frame = window.requestAnimationFrame(tick)");
    expect(html).toContain("removeMotionListener");
    expect(html).toContain('getContext("webgl"');
    expect(html).toContain("u_resolution");
    expect(html).toContain("gl.deleteBuffer(buffer)");
    expect(html).toContain("gl.deleteProgram(program)");
    expect(html).toContain('class="visual-fallback"');
    expect(html).toContain(".canvas-fallback .visual-fallback");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("http://");
  });

  it("starts only for Jarvis distributions", () => {
    expect(shouldStartDesktopJarvisShell("official-jarvis")).toBe(true);
    expect(shouldStartDesktopJarvisShell("unified-jarvis")).toBe(true);
    expect(shouldStartDesktopJarvisShell("standalone")).toBe(false);
  });

  it("routes the shortcut and Talk action to voice without revealing the workspace", () => {
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
    expect(shortcutCallback).toBeDefined();
    expect(trayTemplate.map((item) => item.label)).toEqual([
      "Open Jarvis",
      "Tap Ctrl+Shift+J to talk",
      undefined,
      "Quit",
    ]);

    shortcutCallback?.();
    trayTemplate
      .find((item) => item.label === "Tap Ctrl+Shift+J to talk")
      ?.click?.({} as never, undefined, {} as never);
    expect(calls.filter((call) => call === "voice-toggle")).toHaveLength(2);
    expect(calls).not.toContain("reveal");
    voiceStateListener?.({ status: "capturing" });
    expect(overlay.hide).not.toHaveBeenCalled();
    shell.stop();
  });

  it("keeps tray open and quit actions separate, then cleans up in order", () => {
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
    trayTemplate
      .find((item) => item.label === "Tap Ctrl+Shift+J to talk")
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

  it("uses native press/release edges once and ignores repeats", async () => {
    const calls: string[] = [];
    const listeners = new Map<string, (event: never) => void>();
    const unregister = vi.fn();
    const hook: DesktopPushToTalkHook = {
      on: vi.fn((type, listener) => listeners.set(type, listener as (event: never) => void)),
      removeListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      globalShortcut: { register: vi.fn(() => true), unregister },
      loadPushToTalkHook: async () => hook,
      dispatchVoiceToggle: () => calls.push("voice-toggle"),
      dispatchVoiceStart: () => calls.push("voice-start"),
      dispatchVoiceRelease: () => calls.push("voice-release"),
      revealMain: vi.fn(),
      quit: vi.fn(),
    });

    shell.start();
    await Promise.resolve();
    await Promise.resolve();
    const keydown = listeners.get("keydown");
    const keyup = listeners.get("keyup");
    expect(keydown).toBeDefined();
    expect(keyup).toBeDefined();
    const heldJ = { keycode: desktopPushToTalkKeys.j, ctrlKey: true, shiftKey: true };
    keydown?.(heldJ as never);
    keydown?.(heldJ as never);
    expect(calls).toEqual(["voice-start"]);
    keyup?.(heldJ as never);
    keyup?.(heldJ as never);
    expect(calls).toEqual(["voice-start", "voice-release"]);
    shell.stop();
    expect(hook.stop).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
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

  it("fails closed when no tray asset is available", () => {
    const createTray = vi.fn();
    const closeToTray: boolean[] = [];
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      createTray: createTray as never,
      dispatchVoiceToggle: vi.fn(),
      revealMain: vi.fn(),
      quit: vi.fn(),
      setCloseToTrayEnabled: (enabled) => closeToTray.push(enabled),
    });

    shell.start();

    expect(createTray).not.toHaveBeenCalled();
    expect(closeToTray).toEqual([false]);
    shell.stop();
  });
});
