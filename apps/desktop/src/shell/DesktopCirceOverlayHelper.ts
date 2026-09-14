// @effect-diagnostics nodeBuiltinImport:off globalProcess:off
import * as NodeReadline from "node:readline";

import { app, BrowserWindow, screen } from "electron";

import type { DesktopCirceLiveVoiceState, DesktopCirceOrbCatalog } from "@t3tools/contracts";

import {
  DESKTOP_CIRCE_ORB_CONSOLE_PREFIX,
  desktopCirceOrbCatalogScript,
  desktopCirceOrbStateScript,
  desktopCirceOverlayDataUrl,
  desktopCirceOverlayOrbCenter,
  parseDesktopCirceOverlayEvent,
  resolveDesktopCirceOverlayBounds,
  snapDesktopCirceOverlayAnchor,
  type DesktopCirceOrbDragEvent,
  type DesktopCirceOverlayAnchor,
} from "./DesktopCirceOverlay.ts";

export const DESKTOP_CIRCE_OVERLAY_HELPER_FLAG = "--circe-overlay-helper";
type OverlayCommand =
  | { readonly type: "orb-state"; readonly state: DesktopCirceLiveVoiceState }
  | { readonly type: "orb-catalog"; readonly catalog: DesktopCirceOrbCatalog }
  | { readonly type: "resize"; readonly expanded: boolean }
  | { readonly type: "show" }
  | { readonly type: "hide" }
  | { readonly type: "shutdown" };

export function isDesktopCirceOverlayHelper(argv: ReadonlyArray<string>): boolean {
  return argv.includes(DESKTOP_CIRCE_OVERLAY_HELPER_FLAG);
}

function isLiveVoiceState(value: unknown): value is DesktopCirceLiveVoiceState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.enabled === "boolean" &&
    typeof candidate.active === "boolean" &&
    (candidate.status === "idle" ||
      candidate.status === "requesting" ||
      candidate.status === "connecting" ||
      candidate.status === "live" ||
      candidate.status === "closing" ||
      candidate.status === "failed")
  );
}

function isOrbCatalog(value: unknown): value is DesktopCirceOrbCatalog {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { providers?: unknown }).providers);
}

export function parseDesktopCirceOverlayHelperCommand(line: string): OverlayCommand | null {
  try {
    const value = JSON.parse(line) as Partial<OverlayCommand> & Record<string, unknown>;
    if (value.type === "show" || value.type === "hide" || value.type === "shutdown") return value;
    if (value.type === "orb-state" && isLiveVoiceState(value.state)) {
      return { type: "orb-state", state: value.state };
    }
    if (value.type === "orb-catalog" && isOrbCatalog(value.catalog)) {
      return { type: "orb-catalog", catalog: value.catalog };
    }
    if (value.type === "resize" && typeof value.expanded === "boolean") {
      return { type: "resize", expanded: value.expanded };
    }
  } catch {
    // A partial line cannot affect the resident app; ignore it.
  }
  return null;
}

function parseOverlayCommand(line: string): OverlayCommand | null {
  return parseDesktopCirceOverlayHelperCommand(line);
}

export async function runDesktopCirceOverlayHelper(): Promise<void> {
  await app.whenReady();
  // Middle-right, matching the window-surface orb: XWayland owns placement,
  // so anchor to the primary display's work area.
  const area = screen.getPrimaryDisplay().workArea;
  const collapsedBounds = resolveDesktopCirceOverlayBounds(area, false);
  const window = new BrowserWindow({
    width: collapsedBounds.width,
    height: collapsedBounds.height,
    x: collapsedBounds.x,
    y: collapsedBounds.y,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setAlwaysOnTop(true, "floating");
  await window.loadURL(desktopCirceOverlayDataUrl());
  // The helper owns the window, so it moves the window itself when the orb is
  // dragged; those drag lines are consumed here and never relayed.
  let anchor: DesktopCirceOverlayAnchor | null = null;
  let dragStart: {
    readonly pointerX: number;
    readonly pointerY: number;
    readonly windowX: number;
    readonly windowY: number;
  } | null = null;
  const handleDrag = (event: DesktopCirceOrbDragEvent): void => {
    if (window.isDestroyed()) return;
    if (event.phase === "start") {
      if (event.x === undefined || event.y === undefined) return;
      const bounds = window.getBounds();
      dragStart = {
        pointerX: event.x,
        pointerY: event.y,
        windowX: bounds.x,
        windowY: bounds.y,
      };
      return;
    }
    if (event.phase === "move") {
      if (dragStart === null || event.x === undefined || event.y === undefined) return;
      window.setPosition(
        Math.round(dragStart.windowX + (event.x - dragStart.pointerX)),
        Math.round(dragStart.windowY + (event.y - dragStart.pointerY)),
        false,
      );
      return;
    }
    dragStart = null;
    const area = screen.getPrimaryDisplay().workArea;
    anchor = snapDesktopCirceOverlayAnchor(area, desktopCirceOverlayOrbCenter(window.getBounds()));
    window.setBounds(resolveDesktopCirceOverlayBounds(area, false, anchor), false);
  };
  // Orb picker selections leave the document as console lines. Forward them
  // on stdout so the parent relays them orb -> main -> renderer.
  window.webContents.on("console-message", (_event, _level, message) => {
    if (typeof message !== "string" || !message.startsWith(DESKTOP_CIRCE_ORB_CONSOLE_PREFIX))
      return;
    const parsed = parseDesktopCirceOverlayEvent(message);
    if (parsed !== null && "type" in parsed && parsed.type === "drag") {
      handleDrag(parsed);
      return;
    }
    process.stdout.write(`${message}\n`);
  });

  const lines = NodeReadline.createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    const command = parseOverlayCommand(line);
    if (command === null || window.isDestroyed()) return;
    switch (command.type) {
      case "orb-state":
        void window.webContents.executeJavaScript(desktopCirceOrbStateScript(command.state), true);
        return;
      case "orb-catalog":
        void window.webContents.executeJavaScript(
          desktopCirceOrbCatalogScript(command.catalog),
          true,
        );
        return;
      case "resize": {
        const bounds = resolveDesktopCirceOverlayBounds(
          screen.getPrimaryDisplay().workArea,
          command.expanded,
          anchor ?? undefined,
        );
        window.setFocusable(command.expanded);
        if (command.expanded) window.focus();
        window.setBounds(bounds, false);
        return;
      }
      case "show":
        window.showInactive();
        return;
      case "hide":
        window.hide();
        return;
      case "shutdown":
        app.quit();
    }
  });
  lines.on("close", () => app.quit());
}
