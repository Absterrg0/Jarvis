import { describe, expect, it } from "@effect/vitest";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import {
  JARVIS_GLOBAL_SHORTCUT,
  createDesktopJarvisShell,
  shouldStartDesktopJarvisShell,
} from "./DesktopJarvisShell.ts";
import {
  desktopJarvisOverlayDataUrl,
  desktopJarvisOverlayPresentation,
  desktopJarvisOverlayStateScript,
} from "./DesktopJarvisOverlay.ts";

describe("DesktopJarvisShell", () => {
  it("maps every voice state to a distinct fluid surface profile", () => {
    const profiles = [
      ["starting", "Preparing Jarvis voice", true],
      ["capturing", "Jarvis is listening", true],
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

  it("ships a local canvas renderer with bounded motion and safe fallbacks", () => {
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
    expect(html).toContain("time - lastFrame < 32");
    expect(html).toContain("if (isAnimated()) frame = window.requestAnimationFrame(tick)");
    expect(html).toContain("removeMotionListener");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("webgl");
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
      "Talk to Jarvis",
      undefined,
      "Quit",
    ]);

    shortcutCallback?.();
    trayTemplate
      .find((item) => item.label === "Talk to Jarvis")
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
      .find((item) => item.label === "Talk to Jarvis")
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
});
