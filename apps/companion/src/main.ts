// @effect-diagnostics nodeBuiltinImport:off - Electron's main-process lifecycle and its
// tiny local companion configuration are an imperative native boundary.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Timers from "node:timers/promises";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  Tray,
} from "electron";

import { canStartCapture, takeCaptureForReadyBubble } from "./bubble-state.ts";
import { pairCompanionHost, submitCompanionTask, type HostFetch } from "./host.ts";
import { resolveCompanionLaunch } from "./launch.ts";
import { playNativeCue, recognizeWithWhisper, speakNativeSpeech } from "./native-speech.ts";

const APP_NAME = "Jarvis Companion";
const PAIR_CHANNEL = "jarvis-companion:pair";
const RECOGNIZE_CHANNEL = "jarvis-companion:recognize";
const SPEAK_CHANNEL = "jarvis-companion:speak";
const SUBMIT_TRANSCRIPT_CHANNEL = "jarvis-companion:submit-transcript";
const CAPTURE_START_CHANNEL = "jarvis-companion:capture-start";
const BUBBLE_READY_CHANNEL = "jarvis-companion:bubble-ready";
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
let capturePending = false;
let bubbleReady = false;
let captureInFlight = false;
let recognitionRunning = false;
let captureTimeoutAbort: AbortController | undefined;
let hideBubbleAbort: AbortController | undefined;
let attentionTarget: { readonly projectId: string; readonly threadId: string } | undefined;
let shortcutRegistered = false;
let reportRelayAvailable = false;

const voiceBubbleSize = { width: 230, height: 58, right: 24, bottom: 34 } as const;
const setupWindowSize = { width: 460, height: 300 } as const;

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

function companionSession() {
  return session.fromPartition("persist:jarvis-companion");
}

const hostFetch: HostFetch = (input, init) => companionSession().fetch(input, init);

function whisperPaths() {
  const root = app.isPackaged
    ? join(process.resourcesPath, "jarvis-resources", "whisper")
    : join(app.getAppPath(), "resources", "whisper");
  return {
    executablePath: join(root, "whisper-stream.exe"),
    modelPath: join(root, "ggml-base.en.bin"),
  };
}

function playCue() {
  const root = app.isPackaged
    ? join(process.resourcesPath, "jarvis-resources")
    : join(app.getAppPath(), "resources");
  void playNativeCue(join(root, "listening.wav"));
}

function bubblePage(configured: boolean) {
  const content = configured
    ? `<div class="avatar" aria-hidden="true">J</div><div><strong id="state">Jarvis is listening</strong><span id="detail">Speak your task</span></div>`
    : `<main class="setup" aria-labelledby="setup-title"><header><div class="setup-heading"><p class="eyebrow">JARVIS COMPANION</p><button class="minimize" id="minimize" type="button" aria-label="Minimize Jarvis Companion to the system tray">Minimize</button></div><h1 id="setup-title">Connect this PC</h1><p class="intro">Pair this companion with Jarvis Host. The connection stays private on your tailnet.</p></header><form id="pair-form" novalidate><label for="link">Pairing link</label><input id="link" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://jarvis-host…/pair#token=…" aria-describedby="link-help pair-message" autofocus /><p class="helper" id="link-help">Paste the full link, including <code>/pair#token=</code>.</p><p class="message" id="pair-message" role="status" aria-live="polite">Ready to verify a private connection.</p><button id="connect" type="submit"><span>Connect securely</span></button></form><footer>Runs locally <i aria-hidden="true">·</i> No agents run on this PC</footer></main>`;
  const script = configured
    ? `const state=document.querySelector('#state'),detail=document.querySelector('#detail');const chime=()=>{const audio=new AudioContext(),now=audio.currentTime,osc=audio.createOscillator(),gain=audio.createGain();osc.type='sine';osc.frequency.setValueAtTime(660,now);osc.frequency.exponentialRampToValueAtTime(880,now+.12);gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.055,now+.015);gain.gain.exponentialRampToValueAtTime(.0001,now+.18);osc.connect(gain).connect(audio.destination);osc.start(now);osc.stop(now+.2);setTimeout(()=>audio.close(),300)};const update=(next)=>{state.textContent=next.state;detail.textContent=next.detail;document.body.dataset.state=next.kind||'';if(next.sound||next.kind==='started')chime()};window.addEventListener('t3code:jarvis-capture-start',async()=>{update({state:'Jarvis is listening',detail:'Speak your task',kind:'listening',sound:true});const result=await window.jarvisCompanion.recognizeSpeech();if(!result.ok){update({state:'Voice unavailable',detail:result.message,kind:'error'});return}update({state:'I heard',detail:result.transcript,kind:'routing'});const sent=await window.jarvisCompanion.submitTranscript(result.transcript);if(!sent.ok)update({state:'Could not send',detail:sent.message,kind:'error'})});window.addEventListener('t3code:jarvis-status',event=>update(event.detail));void window.jarvisCompanion.bubbleReady();`
    : `const form=document.querySelector('#pair-form'),link=document.querySelector('#link'),button=document.querySelector('#connect'),buttonLabel=button.querySelector('span'),message=document.querySelector('#pair-message'),minimize=document.querySelector('#minimize');const setMessage=(text,kind='ready')=>{message.textContent=text;message.dataset.kind=kind;message.setAttribute('role',kind==='error'?'alert':'status')};const showError=(text)=>{setMessage(text,'error');link.setAttribute('aria-invalid','true');link.focus()};const submit=async()=>{const candidate=link.value.trim();link.removeAttribute('aria-invalid');if(!candidate){showError('Paste the full Jarvis pairing link to continue.');return}button.disabled=true;buttonLabel.textContent='Connecting…';setMessage('Verifying private connection…','progress');try{const result=await window.jarvisCompanion.submitPairingLink(candidate);if(!result.ok)showError(result.message||'Jarvis could not complete that connection. Try a fresh pairing link.');else setMessage('Connected. Returning to Jarvis…','success')}catch{showError('Jarvis could not complete that connection. Check the link and try again.')}finally{button.disabled=false;buttonLabel.textContent='Connect securely'}};form.addEventListener('submit',event=>{event.preventDefault();void submit()});link.addEventListener('input',()=>{link.removeAttribute('aria-invalid');setMessage('Ready to verify a private connection.')});minimize.addEventListener('click',()=>window.close());`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title><style>
*{box-sizing:border-box}body{margin:0;background:transparent;color:#f2f5f9;font:13px "Segoe UI",SegoeUI,system-ui,sans-serif;overflow:hidden}.voice>div{height:58px;display:flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid #2a3038;border-radius:11px;background:#191c21;box-shadow:0 8px 22px #0008}.setup-shell>div{height:100%}.avatar{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#3479e8;color:#fff;font:700 12px "Segoe UI",system-ui;box-shadow:0 0 0 0 #3479e866}[data-state="listening"] .avatar{animation:pulse 1.25s ease-out infinite}@keyframes pulse{70%{box-shadow:0 0 0 8px #3479e800}100%{box-shadow:0 0 0 0 #3479e800}}strong{display:block;font-size:12px;font-weight:650;line-height:16px;letter-spacing:-.08px}span{display:block;max-width:182px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aeb9c7;font-size:11px;line-height:14px}[data-state="routing"] .avatar{background:#b88938}[data-state="started"] .avatar{background:#27855f}[data-state="error"] .avatar{background:#b65159}.setup{height:100%;padding:20px 32px 15px;border:1px solid #303844;border-radius:14px;background:#171b21;box-shadow:0 18px 46px #000a;display:flex;flex-direction:column}.setup header{margin-bottom:10px}.setup-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}.eyebrow{margin:0;color:#80aefa;font-size:10px;font-weight:700;letter-spacing:1.45px;line-height:1;text-transform:uppercase}.minimize{appearance:none;border:0;background:transparent;color:#8797aa;cursor:pointer;padding:2px 0;font:600 10px "Segoe UI",system-ui,sans-serif;letter-spacing:.15px}.minimize:hover{color:#d5deea}.minimize:focus-visible{outline:2px solid #78a9f466;outline-offset:3px;border-radius:2px}.setup h1{margin:0;color:#f5f7fb;font-size:24px;font-weight:650;letter-spacing:-.5px;line-height:1.15}.intro{max-width:350px;margin:6px 0 0;color:#9caabd;font-size:12px;line-height:16px}.setup form{display:grid;grid-template-columns:1fr auto;column-gap:10px;row-gap:5px}.setup label{grid-column:1/-1;color:#d7dee8;font-size:12px;font-weight:600}.setup input{grid-column:1/-1;width:100%;min-width:0;height:36px;border:1px solid #3b4655;border-radius:7px;outline:none;background:#0f1318;color:#eef3f9;padding:0 11px;font:12px "Segoe UI",system-ui,sans-serif;transition:border-color .14s ease,box-shadow .14s ease}.setup input::placeholder{color:#718094}.setup input:hover{border-color:#56667c}.setup input:focus{border-color:#4b89ed;box-shadow:0 0 0 3px #3479e829}.setup input[aria-invalid="true"]{border-color:#a75a61;box-shadow:0 0 0 3px #a75a6124}.helper{grid-column:1/-1;margin:0;color:#8ea1b9;font-size:11px;line-height:14px}.helper code{font:11px Consolas,"Cascadia Mono",monospace;color:#c4d3e7}.message{grid-column:1/-1;min-height:45px;margin:0;border-left:2px solid #40536b;color:#9bacbf;padding:3px 0 3px 9px;font-size:11px;line-height:13px;overflow-wrap:anywhere}.message[data-kind="progress"]{border-left-color:#588ce0;color:#b5caec}.message[data-kind="success"]{border-left-color:#4f9d79;color:#b8d8c6}.message[data-kind="error"]{border-left-color:#a75a61;color:#e0a3a8}.setup button:not(.minimize){grid-column:1/-1;justify-self:end;min-width:142px;height:30px;margin-top:1px;border:1px solid #5591ee;border-radius:7px;background:#3479e8;color:#fff;cursor:pointer;font:600 12px "Segoe UI",system-ui,sans-serif;letter-spacing:.05px;box-shadow:inset 0 1px #ffffff2b;transition:background .14s ease,border-color .14s ease,transform .08s ease}.setup button:not(.minimize):hover:not(:disabled){background:#4185f0;border-color:#6ca0ef}.setup button:not(.minimize):active:not(:disabled){transform:translateY(1px);background:#2f6fd6}.setup button:not(.minimize):focus-visible{outline:3px solid #78a9f444;outline-offset:2px}.setup button:not(.minimize):disabled{cursor:wait;opacity:.72}.setup footer{margin-top:auto;color:#77869a;font-size:10px;letter-spacing:.15px}.setup footer i{padding:0 4px;color:#536176;font-style:normal}
</style></head><body class="${configured ? "voice" : "setup-shell"}"><div>${content}</div><script>${script}</script></body></html>`)}`;
}

function placeVoiceBubble() {
  if (!bubbleWindow) return;
  const area = screen.getPrimaryDisplay().workArea;
  bubbleWindow.setBounds({
    width: voiceBubbleSize.width,
    height: voiceBubbleSize.height,
    x: area.x + area.width - voiceBubbleSize.width - voiceBubbleSize.right,
    y: area.y + area.height - voiceBubbleSize.height - voiceBubbleSize.bottom,
  });
}

function placeSetupWindow() {
  if (!bubbleWindow) return;
  const area = screen.getPrimaryDisplay().workArea;
  bubbleWindow.setBounds({
    width: setupWindowSize.width,
    height: setupWindowSize.height,
    x: Math.round(area.x + (area.width - setupWindowSize.width) / 2),
    y: Math.round(area.y + (area.height - setupWindowSize.height) / 2),
  });
}

async function loadBubble(configured: boolean) {
  if (configured) placeVoiceBubble();
  else placeSetupWindow();
  if (bubbleWindow) await bubbleWindow.loadURL(bubblePage(configured));
}

function createBubble() {
  const configured = loadSavedHost() !== null;
  const area = screen.getPrimaryDisplay().workArea;
  const initialSize = configured ? voiceBubbleSize : setupWindowSize;
  bubbleWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    x: configured
      ? area.x + area.width - voiceBubbleSize.width - voiceBubbleSize.right
      : Math.round(area.x + (area.width - setupWindowSize.width) / 2),
    y: configured
      ? area.y + area.height - voiceBubbleSize.height - voiceBubbleSize.bottom
      : Math.round(area.y + (area.height - setupWindowSize.height) / 2),
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
  bubbleWindow.webContents.on("did-start-loading", () => {
    bubbleReady = false;
  });
  bubbleWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    bubbleWindow?.hide();
  });
  void loadBubble(configured);
}

function sendCaptureWhenBubbleReady() {
  const next = takeCaptureForReadyBubble({ bubbleReady, capturePending });
  capturePending = next.capturePending;
  if (!next.shouldStart) return;
  bubbleWindow?.webContents.send(CAPTURE_START_CHANNEL);
}

async function loadRelay(url: string) {
  if (relayWindow) await relayWindow.loadURL(url);
}

function connectReportRelay(host: string) {
  void loadRelay(host).catch(() => {
    reportRelayAvailable = false;
    refreshTrayMenu();
  });
}

function createRelay() {
  relayWindow = new BrowserWindow(relayWindowOptions);
  relayWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  relayWindow.webContents.on("did-finish-load", () => {
    reportRelayAvailable = true;
    refreshTrayMenu();
  });
  relayWindow.webContents.on(
    "did-fail-load",
    (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
      if (!isMainFrame) return;
      reportRelayAvailable = false;
      refreshTrayMenu();
    },
  );
  const host = loadSavedHost();
  if (host !== null) connectReportRelay(host);
}

function clearCaptureTimeout() {
  captureTimeoutAbort?.abort();
  captureTimeoutAbort = undefined;
}

function finishCapture() {
  capturePending = false;
  captureInFlight = false;
  clearCaptureTimeout();
}

function startCaptureTimeout() {
  clearCaptureTimeout();
  const controller = new AbortController();
  captureTimeoutAbort = controller;
  void Timers.setTimeout(22_000, undefined, { signal: controller.signal })
    .then(() => {
      if (captureTimeoutAbort !== controller || !captureInFlight) return;
      finishCapture();
      showCompanionStatus({
        state: "Voice capture timed out",
        detail: "Jarvis did not receive a complete sentence. Try again.",
        kind: "error",
      });
    })
    .catch(() => undefined);
}

function startCapture() {
  if (!bubbleWindow) return;
  if (!loadSavedHost()) {
    placeSetupWindow();
    bubbleWindow.showInactive();
    return;
  }
  if (!canStartCapture(captureInFlight)) {
    showCompanionStatus({
      state: "Jarvis is already listening",
      detail: "Finish your current instruction first.",
      kind: "listening",
    });
    return;
  }
  hideBubbleAbort?.abort();
  placeVoiceBubble();
  bubbleWindow.showInactive();
  playCue();
  captureInFlight = true;
  capturePending = true;
  startCaptureTimeout();
  sendCaptureWhenBubbleReady();
}

function showCompanionStatus(status: {
  readonly state: string;
  readonly detail: string;
  readonly kind: string;
}) {
  bubbleWindow?.showInactive();
  bubbleWindow?.webContents.send(STATUS_CHANNEL, status);
  if (status.kind !== "started") return;
  hideBubbleAbort?.abort();
  const controller = new AbortController();
  hideBubbleAbort = controller;
  void Timers.setTimeout(5_000, undefined, { signal: controller.signal })
    .then(() => {
      if (hideBubbleAbort === controller) bubbleWindow?.hide();
    })
    .catch(() => undefined);
}

async function pairHost(
  pairingUrl: string,
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  const result = await pairCompanionHost({ fetch: hostFetch, pairingUrl });
  if (!result.ok) return result;
  saveHost(result.host);
  connectReportRelay(result.host);
  await loadBubble(true);
  bubbleWindow?.hide();
  refreshTrayMenu();
  return { ok: true };
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: shortcutRegistered ? "Speak to Jarvis" : "Speak to Jarvis (hotkey unavailable)",
        click: startCapture,
      },
      {
        label: reportRelayAvailable ? "Voice reports connected" : "Voice reports reconnecting",
        enabled: false,
      },
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
          await companionSession().clearStorageData();
          await loadBubble(false);
          placeSetupWindow();
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
  createRelay();
  createBubble();
  tray = new Tray(
    app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(app.getAppPath(), "../desktop/resources/icon.png"),
  );
  tray.setToolTip(APP_NAME);
  tray.on("click", startCapture);
  shortcutRegistered = globalShortcut.register("CommandOrControl+Shift+J", startCapture);
  refreshTrayMenu();

  ipcMain.handle(PAIR_CHANNEL, async (_event, candidate: unknown) => {
    if (typeof candidate !== "string")
      return { ok: false, message: "Paste the full pairing link." };
    const pairing = resolveCompanionLaunch({
      argv: [`--pairing-url=${candidate}`],
      savedHost: null,
    });
    if (pairing.kind !== "pairing")
      return {
        ok: false,
        message:
          "Paste the complete link ending in /pair#token=…, not only the Jarvis Host address.",
      };
    return pairHost(pairing.url);
  });
  ipcMain.handle(RECOGNIZE_CHANNEL, async () => {
    if (recognitionRunning) {
      return { ok: false, message: "Jarvis is already listening to your current instruction." };
    }
    if (!captureInFlight) {
      return { ok: false, message: "Voice capture expired before it could start. Try again." };
    }
    recognitionRunning = true;
    try {
      const transcript = await recognizeWithWhisper(whisperPaths());
      return transcript.length > 0
        ? { ok: true, transcript }
        : { ok: false, message: "I didn't catch that. Try again." };
    } catch (cause) {
      return {
        ok: false,
        message:
          cause instanceof Error ? cause.message : "Windows speech recognition was unavailable.",
      };
    } finally {
      recognitionRunning = false;
      finishCapture();
    }
  });
  ipcMain.handle(BUBBLE_READY_CHANNEL, (event) => {
    if (event.sender !== bubbleWindow?.webContents) return { accepted: false };
    bubbleReady = true;
    sendCaptureWhenBubbleReady();
    return { accepted: true };
  });
  ipcMain.handle(SUBMIT_TRANSCRIPT_CHANNEL, async (_event, transcript: unknown) => {
    if (typeof transcript !== "string" || transcript.trim().length === 0)
      return { ok: false, message: "No task was heard." };
    const host = loadSavedHost();
    if (host === null)
      return { ok: false, message: "Connect this companion to Jarvis Host first." };
    showCompanionStatus({
      state: "Sending to Jarvis Host",
      detail: "Starting your task directly on the laptop…",
      kind: "routing",
    });
    const result = await submitCompanionTask({
      fetch: hostFetch,
      host,
      utterance: transcript.trim(),
      ...(attentionTarget === undefined ? {} : attentionTarget),
    });
    if (result.kind === "started") {
      if (!reportRelayAvailable) connectReportRelay(host);
      attentionTarget = { projectId: result.projectId, threadId: result.threadId };
      showCompanionStatus({
        state: "Jarvis is working",
        detail: result.objective,
        kind: "started",
      });
      void speakNativeSpeech("Starting your task.");
      return { ok: true };
    }
    if (result.kind === "needs-input") {
      showCompanionStatus({
        state: "Jarvis needs one detail",
        detail: result.prompt,
        kind: "error",
      });
      void speakNativeSpeech(result.prompt);
      return { ok: true };
    }
    showCompanionStatus({
      state: result.needsPairing ? "Reconnect Jarvis" : "Jarvis Host could not start the task",
      detail: result.message,
      kind: "error",
    });
    return { ok: false, message: result.message };
  });
  ipcMain.handle("jarvis-companion:set-attention-target", (event, target: unknown) => {
    if (
      event.sender !== relayWindow?.webContents ||
      typeof target !== "object" ||
      target === null ||
      !("projectId" in target) ||
      !("threadId" in target) ||
      typeof target.projectId !== "string" ||
      typeof target.threadId !== "string" ||
      target.projectId.trim().length === 0 ||
      target.threadId.trim().length === 0
    ) {
      return { accepted: false };
    }
    attentionTarget = { projectId: target.projectId, threadId: target.threadId };
    return { accepted: true };
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
    showCompanionStatus({
      state: status.state,
      detail: status.detail,
      kind: status.kind,
    });
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
      void pairHost(launch.url);
      return;
    }
    startCapture();
  });
  app.whenReady().then(() => {
    start();
    const launch = resolveCompanionLaunch({ argv: process.argv, savedHost: loadSavedHost() });
    if (launch.kind === "pairing") void pairHost(launch.url);
  });
}

app.on("will-quit", () => globalShortcut.unregisterAll());
