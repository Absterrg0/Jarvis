// @effect-diagnostics nodeBuiltinImport:off - Electron's main-process lifecycle and its
// tiny local companion configuration are an imperative native boundary.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, shell, Tray } from "electron";

import { resolveCompanionLaunch } from "./launch.ts";
import { recognizeNativeSpeech } from "./native-speech.ts";

const APP_NAME = "Jarvis Companion";
const PAIR_CHANNEL = "jarvis-companion:pair";
const HIDE_CHANNEL = "jarvis-companion:hide";
const OPEN_CHANNEL = "jarvis-companion:open";
const RECOGNIZE_CHANNEL = "jarvis-companion:recognize";
const windowOptions = {
  width: 640,
  height: 460,
  minWidth: 540,
  minHeight: 400,
  show: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
  backgroundColor: "#0b0b0d",
  webPreferences: {
    partition: "persist:jarvis-companion",
    preload: join(import.meta.dirname, "preload.cjs"),
    contextIsolation: true,
    sandbox: true,
    backgroundThrottling: false,
  },
} as const;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

function configurationPath() {
  return join(app.getPath("userData"), "companion.json");
}

function loadSavedHost(): string | null {
  const path = configurationPath();
  if (!existsSync(path)) return null;

  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" &&
      value !== null &&
      "host" in value &&
      typeof value.host === "string"
      ? value.host
      : null;
  } catch {
    return null;
  }
}

function saveHost(host: string | null) {
  const path = configurationPath();
  const temporaryPath = `${path}.next`;
  writeFileSync(temporaryPath, `${JSON.stringify({ host })}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function setupPage(message = "Paste a fresh pairing link from Jarvis on your laptop.") {
  const escapedMessage = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>${APP_NAME}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5;font:16px system-ui,sans-serif}
main{width:min(540px,calc(100vw - 48px))}h1{font-size:28px;margin:0 0 10px}p{color:#a1a1aa;line-height:1.5}input{width:100%;box-sizing:border-box;padding:13px;border:1px solid #3f3f46;border-radius:8px;background:#18181b;color:#fff;font:14px ui-monospace,monospace}button{margin-top:12px;padding:11px 16px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}.error{color:#fca5a5;min-height:24px}
</style></head><body><main><h1>Connect Jarvis Companion</h1><p>${escapedMessage}</p><input id="link" autocomplete="off" placeholder="http://jarvis-host/pair?token=…" autofocus><div id="error" class="error"></div><button id="connect">Connect</button><script>
const input=document.querySelector('#link');const error=document.querySelector('#error');document.querySelector('#connect').onclick=async()=>{error.textContent='';const result=await window.jarvisCompanion.submitPairingLink(input.value.trim());if(!result.ok)error.textContent=result.message};input.addEventListener('keydown',e=>{if(e.key==='Enter')document.querySelector('#connect').click()});
</script></main></body></html>`)}`;
}

function showWindow(openJarvis = false) {
  if (mainWindow === undefined) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.focus();
  if (openJarvis) mainWindow.webContents.send(OPEN_CHANNEL);
}

function refreshTrayMenu() {
  if (tray === undefined) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Jarvis", click: () => showWindow(true) },
      {
        label: "Open dashboard in browser",
        enabled: loadSavedHost() !== null,
        click: () => {
          const host = loadSavedHost();
          if (host) void shell.openExternal(host);
        },
      },
      { type: "separator" },
      {
        label: "Disconnect this companion",
        click: async () => {
          saveHost(null);
          await mainWindow?.webContents.session.clearStorageData();
          await mainWindow?.loadURL(
            setupPage("Disconnected. Paste a fresh pairing link to connect again."),
          );
          showWindow();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function loadLaunch(url: string, shouldShow: boolean) {
  if (mainWindow === undefined) return;
  await mainWindow.loadURL(url);
  if (shouldShow) showWindow();
}

function createWindow(launch: ReturnType<typeof resolveCompanionLaunch>) {
  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void loadLaunch(launch.kind === "setup" ? setupPage() : launch.url, launch.kind === "setup");
}

function start() {
  const launch = resolveCompanionLaunch({ argv: process.argv, savedHost: loadSavedHost() });
  createWindow(launch);
  tray = new Tray(
    app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(app.getAppPath(), "../desktop/resources/icon.png"),
  );
  tray.setToolTip(APP_NAME);
  tray.on("click", () => showWindow(true));
  refreshTrayMenu();
  globalShortcut.register("CommandOrControl+Shift+J", () => showWindow(true));

  ipcMain.handle(PAIR_CHANNEL, async (_event, candidate: unknown) => {
    if (typeof candidate !== "string")
      return { ok: false, message: "Paste the full pairing link." };
    const pairing = resolveCompanionLaunch({
      argv: [`--pairing-url=${candidate}`],
      savedHost: null,
    });
    if (pairing.kind !== "pairing") {
      return { ok: false, message: "That is not a valid Jarvis pairing link." };
    }
    saveHost(pairing.host);
    await loadLaunch(pairing.url, true);
    return { ok: true };
  });
  ipcMain.handle(HIDE_CHANNEL, () => mainWindow?.hide());
  ipcMain.handle(RECOGNIZE_CHANNEL, async () => {
    try {
      const transcript = await recognizeNativeSpeech();
      return transcript.length > 0
        ? { ok: true, transcript }
        : { ok: false, message: "I didn't catch that. Try again when you're ready." };
    } catch (cause) {
      return {
        ok: false,
        message:
          cause instanceof Error ? cause.message : "Windows speech recognition was unavailable.",
      };
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const launch = resolveCompanionLaunch({ argv, savedHost: loadSavedHost() });
    if (launch.kind === "pairing") {
      saveHost(launch.host);
      void loadLaunch(launch.url, true);
      return;
    }
    showWindow(true);
  });
  app.whenReady().then(start);
}

app.on("will-quit", () => globalShortcut.unregisterAll());
