// @effect-diagnostics nodeBuiltinImport:off - Electron's main-process lifecycle and its
// tiny local companion configuration are an imperative native boundary.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Timers from "node:timers/promises";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, shell, Tray } from "electron";

import { resolveCompanionLaunch } from "./launch.ts";
import { recognizeNativeSpeech, speakNativeSpeech } from "./native-speech.ts";

const APP_NAME = "Jarvis Companion";
const PAIR_CHANNEL = "jarvis-companion:pair";
const RECOGNIZE_CHANNEL = "jarvis-companion:recognize";
const SPEAK_CHANNEL = "jarvis-companion:speak";
const SUBMIT_TRANSCRIPT_CHANNEL = "jarvis-companion:submit-transcript";
const VOICE_TRANSCRIPT_CHANNEL = "jarvis-companion:voice-transcript";
const CAPTURE_START_CHANNEL = "jarvis-companion:capture-start";
const STATUS_CHANNEL = "jarvis-companion:status";
const relayWindowOptions = {
  show: false,
  skipTaskbar: true,
  webPreferences: {
    partition: "persist:jarvis-companion",
    preload: join(import.meta.dirname, "preload.cjs"),
    contextIsolation: true,
    sandbox: true,
    backgroundThrottling: false,
  },
} as const;

let relayWindow: BrowserWindow | undefined;
let bubbleWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let pendingTranscript: string | undefined;
let capturePending = false;
let hideBubbleAbort: AbortController | undefined;

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

function bubblePage(configured: boolean) {
  const content = configured
    ? `<div class="avatar" aria-hidden="true"><i></i><i></i><i></i></div><div><strong id="state">Listening</strong><span id="detail">Speak your task</span></div>`
    : `<div class="pair"><strong>Connect Jarvis</strong><input id="link" placeholder="Paste pairing link" autofocus /><button id="connect">Connect</button><span id="detail">Pair this PC to your laptop once.</span></div>`;
  const script = configured
    ? `const state=document.querySelector('#state'),detail=document.querySelector('#detail');const update=(next)=>{state.textContent=next.state;detail.textContent=next.detail;document.body.dataset.state=next.kind||''};window.addEventListener('t3code:jarvis-capture-start',async()=>{update({state:'Listening',detail:'Speak your task',kind:'listening'});const result=await window.jarvisCompanion.recognizeSpeech();if(!result.ok){update({state:'Voice unavailable',detail:result.message,kind:'error'});return}update({state:'Heard you',detail:result.transcript,kind:'routing'});const sent=await window.jarvisCompanion.submitTranscript(result.transcript);if(!sent.ok)update({state:'Could not send',detail:sent.message,kind:'error'})});window.addEventListener('t3code:jarvis-status',event=>update(event.detail));`
    : `const link=document.querySelector('#link'),detail=document.querySelector('#detail');document.querySelector('#connect').onclick=async()=>{const result=await window.jarvisCompanion.submitPairingLink(link.value.trim());if(!result.ok)detail.textContent=result.message};link.addEventListener('keydown',event=>{if(event.key==='Enter')document.querySelector('#connect').click()});`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title><style>
*{box-sizing:border-box}body{margin:0;background:transparent;color:#f4f4f5;font:13px "Segoe UI",system-ui,sans-serif;overflow:hidden}body>div{height:64px;display:flex;align-items:center;gap:10px;padding:10px 13px;border:1px solid #302f35;border-radius:12px;background:#17161b;box-shadow:0 8px 24px #0008}.avatar{position:relative;display:flex;align-items:center;justify-content:center;gap:2px;width:30px;height:30px;border-radius:50%;background:#5865f2}.avatar i{width:2px;border-radius:2px;background:#fff;animation:talk .7s ease-in-out infinite alternate}.avatar i:nth-child(1){height:8px}.avatar i:nth-child(2){height:14px;animation-delay:.14s}.avatar i:nth-child(3){height:6px;animation-delay:.28s}@keyframes talk{to{transform:scaleY(.45)}}strong{display:block;font-size:12px;font-weight:650;line-height:16px}span{display:block;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aaa9b2;font-size:11px;line-height:15px}[data-state="routing"] .avatar{background:#f0b232}[data-state="started"] .avatar{background:#3ba55d}[data-state="error"] .avatar{background:#ed4245}.pair{height:118px;display:grid;grid-template-columns:1fr auto;gap:8px;padding:12px 14px;border-radius:12px}.pair strong{grid-column:1/-1}.pair input{min-width:0;border:1px solid #3f3f46;border-radius:7px;background:#09090b;color:#fff;padding:8px;font-size:11px}.pair button{border:0;border-radius:7px;background:#5865f2;color:#fff;font-weight:600;padding:0 11px}.pair span{grid-column:1/-1;max-width:none;margin:0}
</style></head><body><div>${content}</div><script>${script}</script></body></html>`)}`;
}

async function loadBubble(configured: boolean) {
  if (bubbleWindow) await bubbleWindow.loadURL(bubblePage(configured));
}

function createBubble() {
  const area = screen.getPrimaryDisplay().workArea;
  bubbleWindow = new BrowserWindow({
    width: 250,
    height: 64,
    x: area.x + area.width - 274,
    y: area.y + area.height - 98,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  bubbleWindow.setAlwaysOnTop(true, "pop-up-menu");
  bubbleWindow.webContents.on("did-finish-load", () => {
    if (!capturePending) return;
    capturePending = false;
    bubbleWindow?.webContents.send(CAPTURE_START_CHANNEL);
  });
  bubbleWindow.on("close", (event) => {
    if (!quitting) event.preventDefault();
  });
  void loadBubble(loadSavedHost() !== null);
}

async function loadRelay(url: string) {
  if (relayWindow) await relayWindow.loadURL(url);
}

function createRelay(launch: ReturnType<typeof resolveCompanionLaunch>) {
  relayWindow = new BrowserWindow(relayWindowOptions);
  relayWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  relayWindow.webContents.on("did-finish-load", () => {
    if (!pendingTranscript) return;
    relayWindow?.webContents.send(VOICE_TRANSCRIPT_CHANNEL, pendingTranscript);
    pendingTranscript = undefined;
  });
  if (launch.kind !== "setup") void loadRelay(launch.url);
}

function startCapture() {
  if (!bubbleWindow) return;
  if (!loadSavedHost()) {
    bubbleWindow.setSize(330, 118);
    bubbleWindow.showInactive();
    return;
  }
  hideBubbleAbort?.abort();
  bubbleWindow.setSize(250, 64);
  bubbleWindow.showInactive();
  shell.beep();
  capturePending = true;
  if (!bubbleWindow.webContents.isLoadingMainFrame()) {
    capturePending = false;
    bubbleWindow.webContents.send(CAPTURE_START_CHANNEL);
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Speak to Jarvis", click: startCapture },
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
          await relayWindow?.webContents.session.clearStorageData();
          await loadBubble(false);
          bubbleWindow?.setSize(330, 118);
          bubbleWindow?.showInactive();
          refreshTrayMenu();
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

function start() {
  const launch = resolveCompanionLaunch({ argv: process.argv, savedHost: loadSavedHost() });
  createRelay(launch);
  createBubble();
  tray = new Tray(
    app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(app.getAppPath(), "../desktop/resources/icon.png"),
  );
  tray.setToolTip(APP_NAME);
  tray.on("click", startCapture);
  refreshTrayMenu();
  globalShortcut.register("CommandOrControl+Shift+J", startCapture);

  ipcMain.handle(PAIR_CHANNEL, async (_event, candidate: unknown) => {
    if (typeof candidate !== "string")
      return { ok: false, message: "Paste the full pairing link." };
    const pairing = resolveCompanionLaunch({
      argv: [`--pairing-url=${candidate}`],
      savedHost: null,
    });
    if (pairing.kind !== "pairing")
      return { ok: false, message: "That is not a valid Jarvis pairing link." };
    saveHost(pairing.host);
    await loadRelay(pairing.url);
    await loadBubble(true);
    bubbleWindow?.hide();
    refreshTrayMenu();
    return { ok: true };
  });
  ipcMain.handle(RECOGNIZE_CHANNEL, async () => {
    try {
      const transcript = await recognizeNativeSpeech();
      return transcript.length > 0
        ? { ok: true, transcript }
        : { ok: false, message: "I didn't catch that. Try again." };
    } catch (cause) {
      return {
        ok: false,
        message:
          cause instanceof Error ? cause.message : "Windows speech recognition was unavailable.",
      };
    }
  });
  ipcMain.handle(SUBMIT_TRANSCRIPT_CHANNEL, (_event, transcript: unknown) => {
    if (typeof transcript !== "string" || transcript.trim().length === 0)
      return { ok: false, message: "No task was heard." };
    if (!relayWindow) return { ok: false, message: "The laptop relay is not ready." };
    if (relayWindow.webContents.isLoadingMainFrame()) {
      pendingTranscript = transcript.trim();
    } else {
      relayWindow.webContents.send(VOICE_TRANSCRIPT_CHANNEL, transcript.trim());
    }
    return { ok: true };
  });
  ipcMain.handle("jarvis-companion:task-status", (_event, status: unknown) => {
    if (
      typeof status !== "object" ||
      status === null ||
      !("state" in status) ||
      !("detail" in status) ||
      typeof status.state !== "string" ||
      typeof status.detail !== "string" ||
      !("kind" in status) ||
      typeof status.kind !== "string"
    ) {
      return;
    }
    bubbleWindow?.showInactive();
    bubbleWindow?.webContents.send(STATUS_CHANNEL, status);
    if (status.kind === "started") {
      shell.beep();
      hideBubbleAbort?.abort();
      const controller = new AbortController();
      hideBubbleAbort = controller;
      void Timers.setTimeout(5_000, undefined, { signal: controller.signal })
        .then(() => {
          if (hideBubbleAbort === controller) bubbleWindow?.hide();
        })
        .catch(() => undefined);
    }
  });
  ipcMain.handle(SPEAK_CHANNEL, async (_event, text: unknown) => {
    if (typeof text !== "string" || text.trim().length === 0) return;
    await speakNativeSpeech(text.trim());
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const launch = resolveCompanionLaunch({ argv, savedHost: loadSavedHost() });
    if (launch.kind === "pairing") {
      saveHost(launch.host);
      void loadRelay(launch.url).then(async () => {
        await loadBubble(true);
        bubbleWindow?.hide();
        refreshTrayMenu();
      });
      return;
    }
    startCapture();
  });
  app.whenReady().then(start);
}

app.on("will-quit", () => globalShortcut.unregisterAll());
