// oxlint-disable t3code/no-global-process-runtime -- dedicated overlay process boundary.
// @effect-diagnostics nodeBuiltinImport:off globalProcess:off
import * as NodeReadline from "node:readline";

import { app, BrowserWindow, screen } from "electron";

import type { DesktopJarvisVoiceState } from "@t3tools/contracts";

import {
  desktopJarvisOverlayDataUrl,
  desktopJarvisOverlayLevelScript,
  desktopJarvisOverlayStateScript,
  type DesktopJarvisOverlayInteraction,
} from "./DesktopJarvisOverlay.ts";

export const DESKTOP_JARVIS_OVERLAY_HELPER_FLAG = "--jarvis-overlay-helper";
const overlayWidth = 310;
const overlayHeight = 68;
const overlayMargin = 28;

type OverlayCommand =
  | {
      readonly type: "state";
      readonly state: DesktopJarvisVoiceState;
      readonly interaction: DesktopJarvisOverlayInteraction;
    }
  | { readonly type: "level"; readonly level: number }
  | { readonly type: "show" }
  | { readonly type: "hide" }
  | { readonly type: "shutdown" };

export function isDesktopJarvisOverlayHelper(argv: ReadonlyArray<string>): boolean {
  return argv.includes(DESKTOP_JARVIS_OVERLAY_HELPER_FLAG);
}

function parseOverlayCommand(line: string): OverlayCommand | null {
  try {
    const value = JSON.parse(line) as Partial<OverlayCommand>;
    if (value.type === "show" || value.type === "hide" || value.type === "shutdown") return value;
    if (value.type === "level" && typeof value.level === "number") return value as OverlayCommand;
    if (
      value.type === "state" &&
      typeof value.state === "object" &&
      value.state !== null &&
      (value.interaction === "hold" || value.interaction === "tap")
    ) {
      return value as OverlayCommand;
    }
  } catch {
    // A partial line cannot affect the resident app; ignore it.
  }
  return null;
}

export async function runDesktopJarvisOverlayHelper(): Promise<void> {
  await app.whenReady();
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: Math.round(area.x + (area.width - overlayWidth) / 2),
    y: area.y + area.height - overlayHeight - overlayMargin,
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
  window.setAlwaysOnTop(true, "floating");
  await window.loadURL(desktopJarvisOverlayDataUrl());

  const lines = NodeReadline.createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    const command = parseOverlayCommand(line);
    if (command === null || window.isDestroyed()) return;
    switch (command.type) {
      case "state":
        void window.webContents.executeJavaScript(
          desktopJarvisOverlayStateScript(command.state, { interaction: command.interaction }),
          true,
        );
        return;
      case "level":
        void window.webContents.executeJavaScript(
          desktopJarvisOverlayLevelScript(command.level),
          true,
        );
        return;
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
