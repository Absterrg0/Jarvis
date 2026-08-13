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
  type IpcMainInvokeEvent,
} from "electron";

import { canStartCapture, queuedBubbleCaptureEvent } from "./bubble-state.ts";
import {
  getCompanionProviderCatalog,
  pairCompanionHost,
  submitCompanionTask,
  type CompanionModelSelection,
  type HostFetch,
} from "./host.ts";
import { resolveCompanionLaunch } from "./launch.ts";
import {
  playNativeCue,
  recognizeWithWhisper,
  speakNativeSpeech,
  startWhisperCapture,
  type WhisperCapture,
} from "./native-speech.ts";
import { voiceOverlaySize, voiceOverlaySizeForStatus } from "./voice-overlay.ts";
import {
  normalizeCompanionProviders,
  readyCompanionProviders,
  validateCompanionDefault,
} from "./provider-defaults.ts";
import { attachPushToTalkHook, type PushToTalkHook } from "./push-to-talk.ts";
import {
  parseCompanionConversationMode,
  parseCompanionSettings,
  withoutCompanionDefault,
  withCompanionConversationMode,
  withCompanionDefault,
  withCompanionHost,
  type CompanionConversationMode,
} from "./settings.ts";
import { isTrustedRelayNavigation } from "./relay-security.ts";

const APP_NAME = "Jarvis Companion";
const PAIR_CHANNEL = "jarvis-companion:pair";
const RECOGNIZE_CHANNEL = "jarvis-companion:recognize";
const SPEAK_CHANNEL = "jarvis-companion:speak";
const SUBMIT_TRANSCRIPT_CHANNEL = "jarvis-companion:submit-transcript";
const CAPTURE_START_CHANNEL = "jarvis-companion:capture-start";
const CAPTURE_STOP_CHANNEL = "jarvis-companion:capture-stop";
const BUBBLE_READY_CHANNEL = "jarvis-companion:bubble-ready";
const STATUS_CHANNEL = "jarvis-companion:status";
const REPORT_RELAY_STATUS_CHANNEL = "jarvis-companion:report-relay-status";
const relayWindowOptions = {
  show: false,
  skipTaskbar: true,
  webPreferences: {
    partition: "persist:jarvis-companion",
    preload: join(import.meta.dirname, "relay-preload.cjs"),
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
let capturePhase: "idle" | "listening" | "checking" = "idle";
let captureInFlight = false;
let activeWhisperCapture: WhisperCapture | undefined;
let legacyRecognitionInFlight = false;
let hideBubbleAbort: AbortController | undefined;
let attentionTarget: { readonly projectId: string; readonly threadId: string } | undefined;
let shortcutRegistered = false;
let hotkeyMode: "hold" | "tap" | "unavailable" = "unavailable";
let detachPushToTalk: (() => void) | undefined;
let reportRelayAvailable = false;
let surface: "voice" | "setup" | undefined;
let latestBubbleStatus:
  | { readonly state: string; readonly detail: string; readonly kind: string }
  | undefined;

const setupWindowSize = { width: 536, height: 526 } as const;

function configurationPath() {
  return join(app.getPath("userData"), "companion.json");
}

function loadCompanionSettings() {
  const path = configurationPath();
  if (!existsSync(path)) return { host: null };
  try {
    return parseCompanionSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { host: null };
  }
}

function saveCompanionSettings(settings: ReturnType<typeof loadCompanionSettings>) {
  const path = configurationPath();
  const temporaryPath = `${path}.next`;
  writeFileSync(temporaryPath, `${JSON.stringify(settings)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function loadSavedHost(): string | null {
  return loadCompanionSettings().host;
}

function loadSavedDefault(): CompanionModelSelection | undefined {
  return loadCompanionSettings().defaultModelSelection;
}

function loadConversationMode(): CompanionConversationMode {
  return loadCompanionSettings().conversationMode ?? "new-thread";
}

function saveHost(host: string | null) {
  saveCompanionSettings(withCompanionHost(loadCompanionSettings(), host));
}

function saveDefault(selection: CompanionModelSelection) {
  saveCompanionSettings(withCompanionDefault(loadCompanionSettings(), selection));
}

function saveConversationMode(conversationMode: CompanionConversationMode) {
  saveCompanionSettings(withCompanionConversationMode(loadCompanionSettings(), conversationMode));
}

function clearSavedDefault() {
  saveCompanionSettings(withoutCompanionDefault(loadCompanionSettings()));
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
  void playNativeCue(join(root, "listening.wav")).catch(() => undefined);
}

function bubblePage(nextSurface: "voice" | "setup") {
  const configured = loadSavedHost() !== null;
  const host = loadSavedHost() ?? "";
  const initialSetup = JSON.stringify({ configured, host });
  const content =
    nextSurface === "voice"
      ? `<main class="voice-surface" aria-label="Jarvis voice command status" aria-live="polite"><div class="voice-orb" aria-hidden="true"><span class="orb-layer orb-bed"></span><span class="orb-layer orb-current"></span><span class="orb-layer orb-caustic"></span><span class="orb-core"></span><span id="rail-state" class="orb-label">ready</span></div><section class="voice-copy"><p id="state">Voice command ready</p><p id="detail">Hold the shortcut to speak an instruction.</p></section><div class="voice-hint"><span id="hint">Hold to talk</span><kbd>Ctrl + Shift + J</kbd></div></main>`
      : `<main class="setup-surface" aria-labelledby="setup-title"><header class="setup-header"><div><p class="product-label">JARVIS / COMPANION</p><h1 id="setup-title">Voice defaults</h1></div><div class="window-controls"><button class="window-button" id="minimize" type="button" aria-label="Minimize Jarvis Companion to the system tray">—</button></div></header><section class="connection-line" aria-label="Connection status"><span id="connection-state" class="connection-state">CHECKING</span><span id="connection-host">Jarvis Host</span></section><p class="setup-intro">Choose what the laptop should use when this PC sends a spoken task.</p><form class="defaults-panel" id="defaults-panel" aria-labelledby="defaults-heading"><div class="section-heading"><p id="defaults-heading">REQUEST DEFAULTS</p><span id="defaults-note">Loading available providers…</span></div><div class="field-grid"><label class="field" for="provider"><span>Provider</span><select id="provider" disabled aria-describedby="setup-message"></select></label><label class="field" for="model"><span>Model</span><select id="model" disabled aria-describedby="setup-message"></select></label><label class="field" id="effort-field" for="effort" hidden><span id="effort-label">Reasoning / effort</span><select id="effort" aria-describedby="setup-message"></select></label><label class="field" id="conversation-field" for="conversation-mode"><span>Conversation</span><select id="conversation-mode" aria-describedby="setup-message"><option value="new-thread">Start a new thread</option><option value="continue-last-thread">Continue latest Jarvis thread</option></select></label></div><p id="selection-summary" class="selection-summary">New requests use the Jarvis Host default.</p><div class="defaults-actions"><button class="primary-button" id="save-defaults" type="submit" disabled>Save defaults</button><button class="secondary-button" id="test-voice" type="button">Test voice</button><button class="link-button" id="open-host-settings" type="button">Open Jarvis Host</button></div></form><section class="empty-provider" id="empty-provider" hidden aria-labelledby="empty-provider-title"><p class="empty-kicker">HOST ACTION NEEDED</p><h2 id="empty-provider-title">No ready provider on Jarvis Host</h2><p>Finish provider setup on the laptop, then reopen this panel. This PC only records and relays your request.</p><button class="secondary-button" id="open-host-empty" type="button">Open host settings</button></section><section class="pairing-panel" id="pairing-panel" hidden aria-labelledby="pairing-title"><div class="section-heading"><p id="pairing-title">PAIR THIS PC</p><span>PRIVATE TAILNET LINK</span></div><form id="pair-form" novalidate><label class="field" for="link"><span>Pairing URL</span><input id="link" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://jarvis-host…/pair#token=…" aria-describedby="link-help setup-message" autofocus /></label><p class="helper" id="link-help">Paste the complete URL, including <code>/pair#token=</code>.</p><button class="primary-button" id="connect" type="submit">Connect companion</button></form></section><p class="setup-message" id="setup-message" role="status" aria-live="polite">Ready.</p><footer><span>RUNS LOCALLY</span><i aria-hidden="true">·</i><span>NO AGENTS RUN ON THIS PC</span><button class="tray-button" id="minimize-footer" type="button">Minimize to tray</button></footer></main>`;
  const script =
    nextSurface === "voice"
      ? `const rail=document.querySelector('#rail-state');const state=document.querySelector('#state');const detail=document.querySelector('#detail');const hint=document.querySelector('#hint');const railLabel=kind=>({listening:'listening',capturing:'listening',checking:'checking',review:'checking',routing:'sending',started:'working',error:'error'}[kind]||'ready');const render=next=>{const kind=next.kind||'ready';const transcript=next.detail||'Hold the shortcut to speak an instruction.';document.body.dataset.state=kind;rail.textContent=railLabel(kind);state.textContent=next.state||'Voice command ready';detail.textContent=transcript;detail.title=transcript;detail.setAttribute('aria-label',transcript);if(kind==='listening'||kind==='capturing')requestAnimationFrame(()=>{detail.scrollTop=detail.scrollHeight});hint.textContent=kind==='listening'||kind==='capturing'?'Release to send':kind==='checking'||kind==='review'?'Checking words':kind==='routing'?'Sending to laptop':kind==='started'?'Jarvis is working':kind==='error'?'Try again':'Hold to talk'};window.addEventListener('t3code:jarvis-capture-start',()=>render({state:'Listening — release to send',detail:'Listening for your instruction…',kind:'listening'}));window.addEventListener('t3code:jarvis-capture-stop',()=>render({state:'Checking transcript',detail:'Listening for the final words…',kind:'checking'}));window.addEventListener('t3code:jarvis-status',event=>render(event.detail||{}));void window.jarvisCompanion.bubbleReady();`
      : `const initial=${initialSetup};const api=window.jarvisCompanion;const byId=id=>document.getElementById(id);const defaultsPanel=byId('defaults-panel');const defaultsForm=defaultsPanel;const emptyProvider=byId('empty-provider');const pairingPanel=byId('pairing-panel');const provider=byId('provider');const model=byId('model');const effort=byId('effort');const effortField=byId('effort-field');const effortLabel=byId('effort-label');const summary=byId('selection-summary');const note=byId('defaults-note');const message=byId('setup-message');const connectionState=byId('connection-state');const connectionHost=byId('connection-host');const save=byId('save-defaults');const link=byId('link');const connect=byId('connect');let setupData=null;let descriptor=null;const setMessage=(text,kind='ready')=>{message.textContent=text;message.dataset.kind=kind;message.setAttribute('role',kind==='error'?'alert':'status')};const invoke=(name,...args)=>typeof api[name]==='function'?api[name](...args):undefined;const text=value=>typeof value==='string'?value.trim():'';const selectValue=item=>text(item&&((item.slug??item.id??item.value??item.name??item.model)));const providerValue=item=>text(item&&((item.instanceId??item.id??item.name)));const providerLabel=item=>text(item&&((item.displayName??item.label??item.name??item.instanceId)))||'Provider';const modelsFor=providerItem=>Array.isArray(providerItem&&providerItem.models)?providerItem.models:[];const optionDescriptors=modelItem=>{const capabilities=modelItem&&modelItem.capabilities;const values=capabilities&&capabilities.optionDescriptors||modelItem&&modelItem.optionDescriptors;return Array.isArray(values)?values:[]};const optionItems=item=>Array.isArray(item&&item.options)?item.options:[];const optionValue=item=>text(item&&((item.value??item.id??item.name)));const optionLabel=item=>text(item&&((item.label??item.name??item.value??item.id)));const clearSelect=element=>{element.replaceChildren()};const addOption=(element,value,label)=>{const item=document.createElement('option');item.value=value;item.textContent=label;element.append(item)};const selectedProvider=()=>Array.isArray(setupData&&setupData.providers)?setupData.providers.find(item=>providerValue(item)===provider.value):undefined;const selectedModel=()=>modelsFor(selectedProvider()).find(item=>selectValue(item)===model.value);const updateSummary=()=>{const name=provider.options[provider.selectedIndex]&&provider.options[provider.selectedIndex].textContent||'Jarvis Host';const modelName=model.options[model.selectedIndex]&&model.options[model.selectedIndex].textContent||'default model';const effortName=!effortField.hidden&&effort.options[effort.selectedIndex]&&effort.options[effort.selectedIndex].textContent;summary.textContent='New requests use '+name+' / '+modelName+(effortName?' / '+effortName+'.':'.')};const renderEffort=selection=>{const descriptors=optionDescriptors(selectedModel());descriptor=descriptors.find(item=>/reason|effort|thinking/i.test(text(item&&((item.id??item.name??item.label)))))||descriptors.find(item=>optionItems(item).length>0);if(!descriptor){effortField.hidden=true;clearSelect(effort);return}const items=optionItems(descriptor);if(!items.length){effortField.hidden=true;return}effortField.hidden=false;effortLabel.textContent=text(descriptor.label??descriptor.name)||'Reasoning / effort';clearSelect(effort);items.forEach(item=>addOption(effort,optionValue(item),optionLabel(item)));const existing=Array.isArray(selection&&selection.options)?selection.options.find(item=>text(item&&item.id)===text(descriptor.id)):undefined;const selected=text(existing&&existing.value);if(selected&&Array.from(effort.options).some(item=>item.value===selected))effort.value=selected};const renderModels=selection=>{clearSelect(model);const models=modelsFor(selectedProvider());models.forEach(item=>addOption(model,selectValue(item),text(item.shortName??item.displayName??item.label??item.name??item.model??item.id)||'Model'));const selected=text(selection&&selection.model);if(selected&&Array.from(model.options).some(item=>item.value===selected))model.value=selected;model.disabled=models.length===0;renderEffort(selection);updateSummary()};const renderProviders=data=>{setupData=data;const all=Array.isArray(data&&data.providers)?data.providers:[];const ready=all.filter(item=>item&&item.status==='ready'&&item.enabled!==false&&item.installed!==false&&(!item.auth||item.auth.status!=='unauthenticated')&&modelsFor(item).length>0);if(!ready.length){defaultsPanel.hidden=true;emptyProvider.hidden=false;return}setupData={...data,providers:ready};defaultsPanel.hidden=false;emptyProvider.hidden=true;clearSelect(provider);ready.forEach(item=>addOption(provider,providerValue(item),providerLabel(item)));const selection=data.defaultModelSelection||data.defaultSelection||data.selection||null;const selected=text(selection&&selection.instanceId);if(selected&&Array.from(provider.options).some(item=>item.value===selected))provider.value=selected;provider.disabled=false;renderModels(selection);save.disabled=false;note.textContent='Saved choices are sent with every spoken request.'};const showConnection=host=>{const value=host===undefined?initial.host:text(host);const connected=Boolean(value);connectionState.textContent=connected?'CONNECTED':'NOT CONNECTED';connectionState.dataset.connected=connected?'true':'false';connectionHost.textContent=connected?value:'Pair with Jarvis Host to continue.';pairingPanel.hidden=connected;defaultsPanel.hidden=!connected;emptyProvider.hidden=true;if(!connected){setMessage('Paste a fresh pairing URL from Jarvis Host.');link.focus()}};const openHost=async()=>{const opened=await invoke('openHost');if(opened===undefined)setMessage('Open Jarvis Host from the companion tray menu.','ready')};const minimize=()=>{const result=invoke('minimize');if(result===undefined)window.close()};const saveDefaults=async()=>{if(!setupData)return;save.disabled=true;setMessage('Saving defaults to this companion…','progress');const selection={instanceId:provider.value,model:model.value,...(!effortField.hidden&&descriptor?{options:[{id:text(descriptor.id),value:effort.value}]}:{})};try{const result=await invoke('saveDefault',selection);if(result===undefined){setMessage('This companion build cannot save defaults yet. Install the current release.','error');return}if(!result.ok){setMessage(result.message||'Jarvis Host rejected those defaults.','error');return}setMessage('Defaults saved. Your next voice request is ready.','success')}catch{setMessage('Defaults could not be saved. Try again.','error')}finally{save.disabled=false}};const initialize=async()=>{showConnection(initial.host);if(!initial.configured)return;setMessage('Checking available providers…','progress');const result=await invoke('getSetup');if(result===undefined){defaultsPanel.hidden=true;emptyProvider.hidden=false;setMessage('Provider defaults will be available after the companion finishes updating.','ready');return}if(!result||result.ok===false){if(result&&result.needsPairing){showConnection(null);setMessage(result.message||'This companion needs a fresh pairing URL from Jarvis Host.','error');return}defaultsPanel.hidden=true;emptyProvider.hidden=false;setMessage(result&&result.message||'Jarvis Host could not load provider defaults.','error');return}if(result.connected===false){showConnection(null);return}showConnection(result.host||initial.host);renderProviders(result);setMessage('Ready to save voice defaults.','success')};provider.addEventListener('change',()=>renderModels(null));model.addEventListener('change',()=>{renderEffort(null);updateSummary()});effort.addEventListener('change',updateSummary);defaultsForm.addEventListener('submit',event=>{event.preventDefault();void saveDefaults()});byId('test-voice').addEventListener('click',async()=>{setMessage('Testing Jarvis voice…','progress');try{const result=await invoke('testVoice');if(result===undefined)await api.speak('Jarvis Companion voice is ready.');setMessage('Voice test sent.','success')}catch{setMessage('Voice test could not start.','error')}});[byId('open-host-settings'),byId('open-host-empty')].filter(Boolean).forEach(button=>button.addEventListener('click',()=>void openHost()));[byId('minimize'),byId('minimize-footer')].filter(Boolean).forEach(button=>button.addEventListener('click',minimize));byId('pair-form').addEventListener('submit',async event=>{event.preventDefault();const candidate=link.value.trim();link.removeAttribute('aria-invalid');if(!candidate){link.setAttribute('aria-invalid','true');setMessage('Paste the complete Jarvis pairing URL.','error');link.focus();return}connect.disabled=true;connect.textContent='Connecting…';setMessage('Verifying the private connection…','progress');try{const result=await api.submitPairingLink(candidate);if(!result.ok){link.setAttribute('aria-invalid','true');setMessage(result.message||'Jarvis could not complete that connection. Try a fresh pairing URL.','error');link.focus()}}catch{link.setAttribute('aria-invalid','true');setMessage('Jarvis could not complete that connection. Check the URL and try again.','error')}finally{connect.disabled=false;connect.textContent='Connect companion'}});link.addEventListener('input',()=>{link.removeAttribute('aria-invalid');setMessage('Ready to verify the private connection.')});window.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();minimize()}});void initialize();`;
  const voiceSurfaceStyle =
    nextSurface === "voice"
      ? `<style>.voice-surface{--orb-deep:#173540;--orb-mid:#426f83;--orb-light:#a8d0d9;--orb-silt:#78a6b4;position:relative;width:100%;height:100%;display:grid;grid-template-columns:62px minmax(0,1fr) 112px;align-items:center;gap:11px;padding:10px 15px 10px 11px;overflow:hidden;border:1px solid rgba(201,214,220,.13);border-radius:25px 15px 15px 25px;background:rgba(16,18,21,.91);box-shadow:0 14px 34px rgba(0,0,0,.34);isolation:isolate}.voice-orb{position:relative;display:grid;place-items:center;width:57px;height:57px;overflow:hidden;border:1px solid rgba(210,227,230,.23);border-radius:48% 52% 50% 50% / 49% 47% 53% 51%;background:var(--orb-deep);box-shadow:inset 3px 4px 12px rgba(225,247,246,.13),inset -7px -9px 15px rgba(5,17,23,.37),0 5px 15px rgba(0,0,0,.26);isolation:isolate}.orb-layer{position:absolute;inset:-26%;display:block;border-radius:49% 51% 48% 52% / 44% 55% 45% 56%;pointer-events:none}.orb-bed{background:radial-gradient(circle at 29% 26%,var(--orb-light) 0 3%,rgba(179,218,221,.54) 15%,transparent 33%),radial-gradient(circle at 64% 73%,var(--orb-silt) 0 14%,transparent 42%),linear-gradient(145deg,var(--orb-mid),var(--orb-deep) 70%);opacity:.94}.orb-current{inset:-39%;background:radial-gradient(ellipse at 33% 46%,rgba(205,237,235,.48) 0 10%,transparent 27%),radial-gradient(ellipse at 66% 66%,rgba(45,105,125,.65) 0 18%,transparent 42%);mix-blend-mode:screen;opacity:.58;transform:translate3d(-3%,2%,0) rotate(-13deg)}.orb-caustic{inset:-16%;background:radial-gradient(ellipse at 28% 64%,rgba(236,249,244,.34) 0 4%,transparent 17%),radial-gradient(ellipse at 68% 28%,rgba(196,230,230,.23) 0 5%,transparent 20%);opacity:.64;transform:rotate(22deg)}.orb-core{position:relative;z-index:1;width:8px;height:8px;border-radius:50%;background:rgba(237,250,246,.81);box-shadow:0 0 0 3px rgba(233,250,248,.08)}.orb-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}.voice-copy{position:relative;z-index:1;min-width:0;align-self:center;user-select:text;-webkit-user-select:text;-webkit-app-region:no-drag}.voice-copy p{margin:0}.voice-copy #state{color:#f1f0ea;font-size:13px;font-weight:625;letter-spacing:-.12px;line-height:18px}.voice-copy #detail{display:-webkit-box;max-height:31px;overflow:hidden;color:#aeb8bd;font-size:12px;line-height:15px;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}.voice-hint{display:flex;flex-direction:column;justify-content:center;align-items:flex-end;gap:4px;min-width:0;color:#717d83;text-align:right}.voice-hint span{font:600 10px var(--ui);line-height:14px}.voice-hint kbd{padding:0;border:0;background:none;color:#8d999f;font:10px var(--mono);white-space:nowrap}.voice-surface:has(#detail:focus-visible){border-color:rgba(164,206,217,.48)}body[data-state="listening"] .voice-surface,body[data-state="capturing"] .voice-surface{--orb-deep:#173b49;--orb-mid:#52889b;--orb-light:#bfdee3;--orb-silt:#7caab6}body[data-state="listening"] .orb-current,body[data-state="capturing"] .orb-current{animation:jarvis-water-drift 8s ease-in-out infinite alternate}body[data-state="listening"] .orb-caustic,body[data-state="capturing"] .orb-caustic{animation:jarvis-water-glint 11s ease-in-out infinite alternate}body[data-state="checking"] .voice-surface,body[data-state="review"] .voice-surface,body[data-state="routing"] .voice-surface{--orb-deep:#453a27;--orb-mid:#876e45;--orb-light:#dbc28f;--orb-silt:#a98d5b}body[data-state="started"] .voice-surface{--orb-deep:#1e4038;--orb-mid:#527e71;--orb-light:#b1d5c5;--orb-silt:#7fa893}body[data-state="error"] .voice-surface{--orb-deep:#472d2d;--orb-mid:#87564f;--orb-light:#e0aaa2;--orb-silt:#aa726b}body[data-state="error"] .voice-copy #state{color:#f0c4c0}body[data-state="review"] .voice-surface{align-items:start;grid-template-columns:62px minmax(0,1fr) 112px;padding-top:14px;padding-bottom:14px}body[data-state="review"] .voice-orb{margin-top:1px}body[data-state="review"] .voice-copy{align-self:stretch;padding-top:1px}body[data-state="review"] .voice-copy #detail{display:block;max-height:194px;overflow-y:auto;padding-right:7px;-webkit-line-clamp:unset;overscroll-behavior:contain;scrollbar-color:#667880 transparent}body[data-state="review"] .voice-hint{align-self:start;padding-top:2px}@keyframes jarvis-water-drift{from{transform:translate3d(-5%,3%,0) rotate(-15deg) scale(1.01)}to{transform:translate3d(5%,-4%,0) rotate(15deg) scale(1.07)}}@keyframes jarvis-water-glint{from{opacity:.38;transform:translate3d(-2%,2%,0) rotate(11deg)}to{opacity:.72;transform:translate3d(3%,-2%,0) rotate(29deg)}}@media (prefers-reduced-motion:reduce){.orb-current,.orb-caustic{animation:none!important}}</style>`
      : "";
  const voiceSurfaceRefinementStyle =
    nextSurface === "voice"
      ? `<style>.voice-surface{grid-template-columns:72px minmax(0,1fr) 70px;gap:0;padding:10px 13px 10px 10px;overflow:visible;border:0;border-radius:0;background:transparent;box-shadow:none}.voice-orb{z-index:2;width:66px;height:66px;border-color:rgba(211,229,231,.27);box-shadow:inset 3px 4px 12px rgba(225,247,246,.15),inset -7px -9px 15px rgba(5,17,23,.39),0 7px 18px rgba(0,0,0,.31)}.voice-copy{z-index:1;min-height:60px;margin-left:-35px;padding:12px 14px 11px 43px;border:1px solid rgba(190,205,211,.11);border-left:0;border-radius:0 17px 17px 0;background:rgba(17,21,24,.77);box-shadow:0 8px 22px rgba(0,0,0,.21)}.voice-copy::before{position:absolute;inset:12px auto 12px 25px;width:1px;background:rgba(175,212,220,.18);content:""}.voice-hint{z-index:1;min-width:0;padding-left:9px;align-self:center}.voice-hint kbd{font-size:9px}body[data-state="listening"] .voice-surface,body[data-state="capturing"] .voice-surface{align-items:start;padding-top:10px;padding-bottom:10px}body[data-state="listening"] .voice-copy,body[data-state="capturing"] .voice-copy{align-self:start;min-height:68px}body[data-state="listening"] .voice-copy #detail,body[data-state="capturing"] .voice-copy #detail{display:block;max-height:62px;overflow-y:auto;padding-right:6px;-webkit-line-clamp:unset;overscroll-behavior:contain;scrollbar-color:#667f89 transparent}body[data-state="listening"] .voice-hint,body[data-state="capturing"] .voice-hint{align-self:start;padding-top:12px}@media (max-width:420px){.voice-surface{grid-template-columns:58px minmax(0,1fr);padding-right:9px}.voice-orb{width:52px;height:52px}.voice-copy{min-height:58px;margin-left:-25px;padding:11px 72px 10px 33px;border-radius:0 14px 14px 0}.voice-copy::before{inset:11px auto 11px 19px}.voice-hint{position:absolute;right:15px;bottom:17px;padding:0;pointer-events:none}.voice-hint span{display:none}.voice-hint kbd{font-size:9px}body[data-state="listening"] .voice-hint,body[data-state="capturing"] .voice-hint{top:15px;bottom:auto;padding-top:0}body[data-state="listening"] .voice-copy,body[data-state="capturing"] .voice-copy{padding-right:14px}}</style>`
      : "";
  const voiceReviewStyle =
    nextSurface === "voice"
      ? `<style>body[data-state="review"] .voice-copy #detail{display:block;max-height:194px;overflow-y:auto;overscroll-behavior:contain;padding-right:7px;-webkit-line-clamp:unset;scrollbar-color:#667880 transparent}</style>`
      : "";
  const voiceReviewScript =
    nextSurface === "voice"
      ? `const updateReviewAffordance=()=>{const reviewing=document.body.dataset.state==='review';const scrollable=reviewing&&detail.scrollHeight>detail.clientHeight;detail.tabIndex=scrollable?0:-1;if(scrollable)hint.textContent='SCROLL TO REVIEW'};new MutationObserver(updateReviewAffordance).observe(document.body,{attributes:true,attributeFilter:['data-state']});updateReviewAffordance();`
      : "";
  const conversationModeScript =
    nextSurface === "setup"
      ? `<script>(()=>{const mode=document.getElementById('conversation-mode');if(!mode)return;void window.jarvisCompanion.getSetup?.().then(result=>{if(result&&result.ok&&typeof result.conversationMode==='string')mode.value=result.conversationMode});mode.addEventListener('change',async()=>{const result=await window.jarvisCompanion.saveConversationMode?.(mode.value);if(!result||!result.ok){mode.value='new-thread';document.getElementById('setup-message').textContent=(result&&result.message)||'Conversation mode could not be saved.'}})})()</script>`
      : "";
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title><style>
:root{color-scheme:dark;--paper:#151719;--ground:#0d0f11;--line:#353a40;--line-quiet:#252a2f;--ink:#f1eee7;--muted:#a7adb4;--dim:#747c85;--blue:#7096b5;--blue-bright:#8cb5d5;--ochre:#b89a63;--brick:#bd7771;--green:#80ad94;--mono:"Cascadia Mono","SFMono-Regular",Consolas,monospace;--ui:"Segoe UI Variable","Segoe UI",system-ui,sans-serif}*{box-sizing:border-box}html,body,#surface-root{width:100%;height:100%}body{margin:0;background:transparent;color:var(--ink);font:13px var(--ui);overflow:hidden}#surface-root{overflow:hidden}button,input,select{font:inherit}.telemetry{width:100%;height:100%;display:grid;grid-template-columns:88px minmax(0,1fr) 116px;align-items:stretch;border:1px solid var(--line);border-radius:5px;background:var(--paper);overflow:hidden}.state-rail{display:flex;align-items:center;gap:8px;padding:0 13px;border-right:1px solid var(--line);color:var(--muted);font:700 10px var(--mono);letter-spacing:.52px}.indicator{display:block;width:7px;height:7px;background:#69717a;transition:background .15s ease}.telemetry-copy{min-width:0;align-self:center;padding:0 16px}.telemetry-copy p{margin:0}.telemetry-copy #state{color:var(--ink);font-size:13px;font-weight:650;letter-spacing:-.12px;line-height:18px}.telemetry-copy #detail{display:-webkit-box;max-height:30px;overflow:hidden;color:var(--muted);font-size:12px;line-height:15px;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}body[data-state="review"] .telemetry-copy{align-self:start;padding-top:17px;padding-bottom:17px}body[data-state="review"] .telemetry-copy #detail{max-height:210px;-webkit-line-clamp:14}.hotkey-hint{display:flex;flex-direction:column;justify-content:center;align-items:flex-end;gap:5px;padding:0 14px;border-left:1px solid var(--line);color:var(--dim)}.hotkey-hint span{font:700 9px var(--mono);letter-spacing:.45px;text-align:right}.hotkey-hint kbd{color:var(--muted);font:10px var(--mono);white-space:nowrap}body[data-state="listening"] .indicator,body[data-state="capturing"] .indicator{background:var(--blue-bright)}body[data-state="review"] .indicator,body[data-state="checking"] .indicator,body[data-state="routing"] .indicator{background:var(--ochre)}body[data-state="started"] .indicator{background:var(--green)}body[data-state="error"] .indicator{background:var(--brick)}body[data-state="error"] .telemetry-copy #state{color:#f0bbb6}.setup-surface{width:100%;height:100%;min-height:0;padding:17px 24px 12px;border:1px solid var(--line);border-radius:5px;background:var(--paper);display:flex;flex-direction:column}.setup-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.product-label,.section-heading p,.empty-kicker{margin:0;color:var(--blue-bright);font:700 10px var(--mono);letter-spacing:1px;line-height:14px}.setup-header h1{margin:3px 0 0;color:var(--ink);font-size:24px;font-weight:620;letter-spacing:-.5px;line-height:27px}.window-controls{display:flex;align-items:center;gap:9px;padding-top:1px}.window-button,.link-button,.tray-button{appearance:none;border:0;background:transparent;color:var(--muted);cursor:pointer}.window-button{width:24px;height:24px;color:var(--dim);font:16px/18px var(--ui)}.window-button:hover,.link-button:hover,.tray-button:hover{color:var(--ink)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--blue-bright);outline-offset:2px}.connection-line{display:flex;align-items:center;gap:9px;min-height:26px;margin-top:10px;padding:5px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;overflow:hidden}.connection-state{flex:0 0 auto;color:var(--ochre);font:700 9px var(--mono);letter-spacing:.5px}.connection-state[data-connected="true"]{color:var(--green)}#connection-host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.setup-intro{margin:8px 0 10px;color:var(--muted);font-size:12px;line-height:16px}.defaults-panel,.pairing-panel{border-top:1px solid var(--line-quiet);border-bottom:1px solid var(--line-quiet);padding:9px 0}.section-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}.section-heading span{color:var(--dim);font:9px var(--mono);letter-spacing:.42px}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px}.field{display:grid;gap:4px;color:#d7d8d5;font-size:11px;font-weight:600}.field span{color:#d1d4d8}.field select,.field input{width:100%;min-width:0;height:32px;border:1px solid #3c4249;border-radius:4px;background:var(--ground);color:var(--ink);padding:0 9px;font-size:12px;outline:none}.field select:disabled{color:#7f858c}.field input::placeholder{color:#687078}.field input[aria-invalid="true"]{border-color:var(--brick)}#effort-field{grid-column:1/-1}.selection-summary{min-height:16px;margin:8px 0 0;color:var(--muted);font-size:11px;line-height:16px}.defaults-actions{display:flex;align-items:center;gap:9px;margin-top:10px}.primary-button,.secondary-button{height:30px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:650}.primary-button{border:1px solid var(--blue-bright);background:var(--blue);color:#0d1114;padding:0 13px}.primary-button:hover:not(:disabled){background:var(--blue-bright)}.primary-button:disabled{cursor:wait;opacity:.58}.secondary-button{border:1px solid #505861;background:#20242a;color:#e4e4df;padding:0 11px}.secondary-button:hover{border-color:#78818b;background:#262c32}.link-button{margin-left:auto;padding:5px 0;font-size:11px}.empty-provider{margin:auto 0;padding:18px 0;border-top:1px solid var(--line-quiet);border-bottom:1px solid var(--line-quiet)}.empty-provider h2{margin:7px 0 5px;color:var(--ink);font-size:17px;font-weight:620;letter-spacing:-.2px}.empty-provider p:not(.empty-kicker){max-width:420px;margin:0 0 13px;color:var(--muted);font-size:12px;line-height:17px}.pairing-panel form{display:grid;gap:8px}.helper{margin:0;color:var(--dim);font-size:11px;line-height:15px}.helper code{color:#d4d8dd;font:11px var(--mono)}.pairing-panel .primary-button{justify-self:start}.setup-message{min-height:31px;margin:9px 0 0;padding:5px 0 0 9px;border-left:2px solid #48525d;color:var(--muted);font-size:11px;line-height:14px;overflow-wrap:anywhere}.setup-message[data-kind="progress"]{border-color:var(--blue);color:#b8cce0}.setup-message[data-kind="success"]{border-color:var(--green);color:#bbd4c4}.setup-message[data-kind="error"]{border-color:var(--brick);color:#e5afab}.setup-surface footer{display:flex;align-items:center;gap:6px;margin-top:auto;padding-top:9px;color:var(--dim);font:9px var(--mono);letter-spacing:.32px}.setup-surface footer i{font-style:normal;color:#525a63}.tray-button{margin-left:auto;padding:2px 0;color:#9ca4ac;font:9px var(--mono);letter-spacing:.32px}
</style>${voiceSurfaceStyle}${voiceSurfaceRefinementStyle}${voiceReviewStyle}</head><body><div id="surface-root">${content}</div><script>${script}${voiceReviewScript}</script>${conversationModeScript}</body></html>`)}`;
}

function placeVoiceOverlay(status?: { readonly kind: string; readonly detail: string }) {
  if (!bubbleWindow) return;
  const area = screen.getPrimaryDisplay().workArea;
  const baseSize = voiceOverlaySizeForStatus(status);
  const isLiveTranscript = status?.kind === "listening" || status?.kind === "capturing";
  const estimatedLines = Math.max(
    1,
    (status?.detail ?? "").split(/\r?\n/u).reduce((total, line) => {
      return total + Math.max(1, Math.ceil(line.length / 46));
    }, 0),
  );
  const size =
    isLiveTranscript && estimatedLines > 2
      ? { ...baseSize, height: Math.min(136, Math.max(baseSize.height, 42 + estimatedLines * 15)) }
      : baseSize;
  bubbleWindow.setBounds({
    width: size.width,
    height: size.height,
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: area.y + area.height - size.height - size.bottom,
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

async function loadSurface(
  nextSurface: "voice" | "setup",
  forceReload = false,
  voiceStatus?: { readonly kind: string; readonly detail: string },
) {
  if (!bubbleWindow) return;
  const needsNavigation = forceReload || surface !== nextSurface;
  surface = nextSurface;
  if (nextSurface === "voice") placeVoiceOverlay(voiceStatus);
  else placeSetupWindow();
  if (needsNavigation) await bubbleWindow.loadURL(bubblePage(nextSurface));
}

function openCompanionSetup() {
  hideBubbleAbort?.abort();
  void loadSurface("setup", true).then(() => bubbleWindow?.showInactive());
}

function createBubble() {
  const configured = loadSavedHost() !== null;
  const area = screen.getPrimaryDisplay().workArea;
  const initialSurface = configured ? "voice" : "setup";
  const initialSize = initialSurface === "voice" ? voiceOverlaySize : setupWindowSize;
  bubbleWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    x:
      initialSurface === "voice"
        ? Math.round(area.x + (area.width - voiceOverlaySize.width) / 2)
        : Math.round(area.x + (area.width - setupWindowSize.width) / 2),
    y:
      initialSurface === "voice"
        ? area.y + area.height - voiceOverlaySize.height - voiceOverlaySize.bottom
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
  void loadSurface(initialSurface);
}

function flushVoiceOverlay() {
  if (!bubbleReady || !bubbleWindow || surface !== "voice") return;
  const next = queuedBubbleCaptureEvent({ bubbleReady, capturePending, phase: capturePhase });
  capturePending = next.capturePending;
  if (next.event === "start") bubbleWindow.webContents.send(CAPTURE_START_CHANNEL);
  if (next.event === "stop") bubbleWindow.webContents.send(CAPTURE_STOP_CHANNEL);
  if (latestBubbleStatus !== undefined) {
    bubbleWindow.webContents.send(STATUS_CHANNEL, latestBubbleStatus);
  }
}

function isBubbleSender(event: IpcMainInvokeEvent): boolean {
  return event.sender === bubbleWindow?.webContents;
}

function isRelaySender(event: IpcMainInvokeEvent): boolean {
  return (
    event.sender === relayWindow?.webContents &&
    isTrustedRelayNavigation({
      destination: event.sender.getURL(),
      pairedHost: loadSavedHost(),
    })
  );
}

async function loadRelay(url: string) {
  if (relayWindow) await relayWindow.loadURL(url);
}

function connectReportRelay(host: string) {
  reportRelayAvailable = false;
  refreshTrayMenu();
  createRelay();
  void loadRelay(host).catch(() => {
    reportRelayAvailable = false;
    refreshTrayMenu();
  });
}

function createRelay() {
  if (relayWindow !== undefined) return;
  relayWindow = new BrowserWindow(relayWindowOptions);
  relayWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const preventUntrustedRelayNavigation = (event: Electron.Event, url: string) => {
    if (isTrustedRelayNavigation({ destination: url, pairedHost: loadSavedHost() })) return;
    event.preventDefault();
    reportRelayAvailable = false;
    refreshTrayMenu();
  };
  relayWindow.webContents.on("will-navigate", preventUntrustedRelayNavigation);
  relayWindow.webContents.on("will-redirect", preventUntrustedRelayNavigation);
  relayWindow.webContents.on(
    "did-fail-load",
    (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
      if (!isMainFrame) return;
      reportRelayAvailable = false;
      refreshTrayMenu();
    },
  );
}

function disconnectReportRelay() {
  reportRelayAvailable = false;
  relayWindow?.destroy();
  relayWindow = undefined;
}

function finishCapture() {
  capturePending = false;
  capturePhase = "idle";
  captureInFlight = false;
  activeWhisperCapture = undefined;
}

function captureFailurePresentation(cause: unknown) {
  const detail =
    cause instanceof Error ? cause.message : "Jarvis could not capture that instruction.";
  if (/stopped before recognizing speech|didn't hear a complete instruction/iu.test(detail)) {
    return {
      state: "I didn't catch that",
      detail: "Hold until the soft tone, then speak naturally and release when you finish.",
    };
  }
  return { state: "Voice unavailable", detail };
}

function requireVoiceDefault():
  | {
      readonly host: string;
      readonly modelSelection: CompanionModelSelection;
      readonly conversationMode: CompanionConversationMode;
    }
  | undefined {
  const host = loadSavedHost();
  const modelSelection = loadSavedDefault();
  if (host !== null && modelSelection !== undefined) {
    return { host, modelSelection, conversationMode: loadConversationMode() };
  }
  openCompanionSetup();
  return undefined;
}

function showVoiceCapture() {
  capturePending = true;
  capturePhase = "listening";
  latestBubbleStatus = undefined;
  void loadSurface("voice").then(() => {
    if (!captureInFlight) return;
    bubbleWindow?.showInactive();
    flushVoiceOverlay();
  });
}

async function dispatchCapturedTranscript(
  transcript: string,
  voiceDefault: {
    readonly host: string;
    readonly modelSelection: CompanionModelSelection;
    readonly conversationMode: CompanionConversationMode;
  },
) {
  showCompanionStatus({
    state: "Checking transcript",
    detail: transcript,
    kind: "review",
  });
  // Keep the exact final words visible before the host receives them. This is
  // not an arbitrary capture delay; it is an intentional verification beat.
  await Timers.setTimeout(850);
  return await submitTranscriptToHost(transcript, voiceDefault);
}

function startHeldCapture() {
  if (!bubbleWindow) return;
  const voiceDefault = requireVoiceDefault();
  if (voiceDefault === undefined) return;
  if (!canStartCapture(captureInFlight)) {
    showCompanionStatus({
      state: "Jarvis is already listening",
      detail: "Finish your current instruction first.",
      kind: "listening",
    });
    return;
  }
  hideBubbleAbort?.abort();
  captureInFlight = true;
  showVoiceCapture();
  showCompanionStatus({
    state: "Waking the microphone",
    detail: "One moment — start speaking when you hear the soft tone.",
    kind: "arming",
  });
  try {
    const capture = startWhisperCapture({
      ...whisperPaths(),
      onReady: () => {
        // A very quick release may happen while the audio device is opening.
        // Never play the ready cue or regress the surface back to listening
        // after that release has already begun transcript finalisation.
        if (!captureInFlight || capturePhase !== "listening") return;
        playCue();
        showCompanionStatus({
          state: "Listening — release to send",
          detail: "Speak naturally, then release the shortcut.",
          kind: "listening",
        });
      },
      onTranscript: (transcript) => {
        if (!captureInFlight) return;
        showCompanionStatus({
          state: "Listening — release to send",
          detail: transcript,
          kind: "listening",
        });
      },
    });
    activeWhisperCapture = capture;
    void capture.result
      .then(async (transcript) => {
        return await dispatchCapturedTranscript(transcript, voiceDefault);
      })
      .catch((cause) => {
        const presentation = captureFailurePresentation(cause);
        showCompanionStatus({
          ...presentation,
          kind: "error",
        });
      })
      .finally(finishCapture);
  } catch (cause) {
    finishCapture();
    showCompanionStatus({
      state: "Voice unavailable",
      detail:
        cause instanceof Error ? cause.message : "Jarvis could not start local transcription.",
      kind: "error",
    });
  }
}

function releaseHeldCapture() {
  if (!captureInFlight || activeWhisperCapture === undefined) return;
  capturePhase = "checking";
  flushVoiceOverlay();
  showCompanionStatus({
    state: "Checking transcript",
    detail: "Listening for the final words…",
    kind: "checking",
  });
  activeWhisperCapture.release();
}

function startOneShotCapture() {
  if (!bubbleWindow) return;
  const voiceDefault = requireVoiceDefault();
  if (voiceDefault === undefined) return;
  if (!canStartCapture(captureInFlight)) {
    showCompanionStatus({
      state: "Jarvis is already listening",
      detail: "Finish your current instruction first.",
      kind: "listening",
    });
    return;
  }
  hideBubbleAbort?.abort();
  captureInFlight = true;
  showVoiceCapture();
  showCompanionStatus({
    state: "Listening",
    detail: "Speak your instruction, then pause to send it.",
    kind: "listening",
  });
  void recognizeWithWhisper(whisperPaths())
    .then((transcript) => dispatchCapturedTranscript(transcript, voiceDefault))
    .catch((cause) => {
      showCompanionStatus({
        state: "Voice unavailable",
        detail:
          cause instanceof Error ? cause.message : "Jarvis could not capture that instruction.",
        kind: "error",
      });
    })
    .finally(finishCapture);
}

function showCompanionStatus(status: {
  readonly state: string;
  readonly detail: string;
  readonly kind: string;
}) {
  latestBubbleStatus = status;
  void loadSurface("voice", false, status).then(() => {
    bubbleWindow?.showInactive();
    flushVoiceOverlay();
  });
  if (status.kind !== "started") return;
  hideBubbleAbort?.abort();
  const controller = new AbortController();
  hideBubbleAbort = controller;
  void Timers.setTimeout(7_000, undefined, { signal: controller.signal })
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
  await loadSurface("setup", true);
  bubbleWindow?.showInactive();
  refreshTrayMenu();
  return { ok: true };
}

async function submitTranscriptToHost(
  transcript: string,
  voiceDefault = requireVoiceDefault(),
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  if (transcript.trim().length === 0) {
    return { ok: false, message: "No task was heard." };
  }
  if (voiceDefault === undefined) {
    return {
      ok: false,
      message: "Choose voice defaults before sending a task.",
    };
  }

  showCompanionStatus({
    state: "Sending to Jarvis Host",
    detail: "Starting your task directly on the laptop…",
    kind: "routing",
  });
  const continuationTarget =
    voiceDefault.conversationMode === "continue-last-thread" ? attentionTarget : undefined;
  const result = await submitCompanionTask({
    fetch: hostFetch,
    host: voiceDefault.host,
    utterance: transcript.trim(),
    ...(continuationTarget === undefined
      ? { modelSelection: voiceDefault.modelSelection }
      : {
          projectId: continuationTarget.projectId,
          contextThreadId: continuationTarget.threadId,
          continueContext: true,
        }),
  });
  if (result.kind === "started") {
    if (!reportRelayAvailable) connectReportRelay(voiceDefault.host);
    attentionTarget = { projectId: result.projectId, threadId: result.threadId };
    showCompanionStatus({
      state: "Jarvis is working",
      detail: result.objective,
      kind: "started",
    });
    void speakNativeSpeech(
      continuationTarget === undefined ? "On it." : "Picking that back up.",
    ).catch(() => undefined);
    return { ok: true };
  }
  if (result.kind === "needs-input") {
    showCompanionStatus({
      state: "Jarvis needs one detail",
      detail: result.prompt,
      kind: "error",
    });
    void speakNativeSpeech(result.prompt).catch(() => undefined);
    if (
      [
        "selection-unavailable",
        "provider-not-found",
        "provider-unavailable",
        "model-unavailable",
        "effort-missing",
        "effort-unavailable",
      ].includes(result.reason)
    ) {
      clearSavedDefault();
      openCompanionSetup();
    }
    return { ok: true };
  }
  showCompanionStatus({
    state: result.needsPairing ? "Reconnect Jarvis" : "Jarvis Host could not start the task",
    detail: result.message,
    kind: "error",
  });
  void speakNativeSpeech(
    result.needsPairing
      ? "Jarvis needs a fresh pairing link."
      : "Jarvis Host could not start the task. Check the voice overlay for details.",
  ).catch(() => undefined);
  if (result.needsPairing) openCompanionSetup();
  return { ok: false, message: result.message };
}

async function readSetup() {
  const host = loadSavedHost();
  if (host === null) {
    return {
      ok: true,
      connected: false,
      host: null,
      providers: [],
    } as const;
  }
  const catalog = await getCompanionProviderCatalog({ fetch: hostFetch, host });
  if (catalog.kind === "error") {
    return { ok: false, message: catalog.message, needsPairing: catalog.needsPairing } as const;
  }
  return {
    ok: true,
    connected: true,
    host,
    providers: normalizeCompanionProviders(catalog.providers),
    ...(loadSavedDefault() === undefined ? {} : { defaultModelSelection: loadSavedDefault() }),
    conversationMode: loadConversationMode(),
  } as const;
}

async function saveVoiceDefault(candidate: unknown) {
  const host = loadSavedHost();
  if (host === null) {
    return {
      ok: false,
      message: "Connect this companion to Jarvis Host first.",
      needsPairing: true,
    } as const;
  }
  const catalog = await getCompanionProviderCatalog({ fetch: hostFetch, host });
  if (catalog.kind === "error") {
    if (catalog.needsPairing) openCompanionSetup();
    return {
      ok: false,
      message: catalog.message,
      needsPairing: catalog.needsPairing,
    } as const;
  }
  const selection = validateCompanionDefault({
    providers: readyCompanionProviders(normalizeCompanionProviders(catalog.providers)),
    candidate,
  });
  if (!selection.ok) return selection;
  saveDefault(selection.selection);
  return { ok: true } as const;
}

async function installVoiceHotkey() {
  if (process.platform === "win32") {
    try {
      const { uIOhook } = await import("uiohook-napi");
      detachPushToTalk = attachPushToTalkHook({
        hook: uIOhook as PushToTalkHook,
        onPressed: startHeldCapture,
        onReleased: releaseHeldCapture,
      });
      hotkeyMode = "hold";
      refreshTrayMenu();
      return;
    } catch {
      // A local fallback remains useful if a device policy blocks the native hook.
    }
  }
  shortcutRegistered = globalShortcut.register("CommandOrControl+Shift+J", startOneShotCapture);
  hotkeyMode = shortcutRegistered ? "tap" : "unavailable";
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const speakLabel =
    hotkeyMode === "hold"
      ? "Hold Ctrl+Shift+J to talk"
      : hotkeyMode === "tap"
        ? "Speak to Jarvis (tap-to-talk fallback)"
        : "Speak to Jarvis (hotkey unavailable)";
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: speakLabel,
        click: startOneShotCapture,
      },
      {
        label: "Voice defaults…",
        click: openCompanionSetup,
      },
      {
        label: "Conversation mode",
        submenu: [
          {
            label: "Start each request in a new thread",
            type: "radio",
            checked: loadConversationMode() === "new-thread",
            click: () => {
              saveConversationMode("new-thread");
              refreshTrayMenu();
            },
          },
          {
            label: "Continue the latest reported thread",
            type: "radio",
            checked: loadConversationMode() === "continue-last-thread",
            click: () => {
              saveConversationMode("continue-last-thread");
              refreshTrayMenu();
            },
          },
        ],
      },
      {
        label: reportRelayAvailable ? "Voice reports connected" : "Voice reports reconnecting",
        enabled: false,
      },
      {
        label: "Open Jarvis Host",
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
          attentionTarget = undefined;
          disconnectReportRelay();
          await companionSession().clearStorageData();
          await loadSurface("setup", true);
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
  const host = loadSavedHost();
  if (host !== null) connectReportRelay(host);
  createBubble();
  tray = new Tray(
    app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(app.getAppPath(), "../desktop/resources/icon.png"),
  );
  tray.setToolTip(APP_NAME);
  tray.on("click", startOneShotCapture);
  refreshTrayMenu();
  void installVoiceHotkey();

  ipcMain.handle(PAIR_CHANNEL, async (_event, candidate: unknown) => {
    if (!isBubbleSender(_event))
      return { ok: false, message: "This action is only available in Jarvis Companion." };
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
  ipcMain.handle(RECOGNIZE_CHANNEL, async (event) => {
    if (!isBubbleSender(event)) {
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    }
    if (legacyRecognitionInFlight || captureInFlight) {
      return { ok: false, message: "Jarvis is already listening to your current instruction." };
    }
    legacyRecognitionInFlight = true;
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
      legacyRecognitionInFlight = false;
    }
  });
  ipcMain.handle(BUBBLE_READY_CHANNEL, (event) => {
    if (!isBubbleSender(event) || surface !== "voice") return { accepted: false };
    bubbleReady = true;
    flushVoiceOverlay();
    return { accepted: true };
  });
  ipcMain.handle(SUBMIT_TRANSCRIPT_CHANNEL, async (event, transcript: unknown) => {
    if (!isBubbleSender(event)) {
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    }
    if (typeof transcript !== "string" || transcript.trim().length === 0)
      return { ok: false, message: "No task was heard." };
    return await submitTranscriptToHost(transcript);
  });
  ipcMain.handle("jarvis-companion:get-setup", async (event) => {
    if (!isBubbleSender(event))
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    return await readSetup();
  });
  ipcMain.handle("jarvis-companion:save-default", async (event, candidate: unknown) => {
    if (!isBubbleSender(event))
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    return await saveVoiceDefault(candidate);
  });
  ipcMain.handle("jarvis-companion:save-conversation-mode", (event, candidate: unknown) => {
    if (!isBubbleSender(event)) {
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    }
    const conversationMode = parseCompanionConversationMode(candidate);
    if (conversationMode === undefined) {
      return { ok: false, message: "Choose a valid conversation mode." };
    }
    saveConversationMode(conversationMode);
    refreshTrayMenu();
    return { ok: true };
  });
  ipcMain.handle("jarvis-companion:open-host", async (event) => {
    if (!isBubbleSender(event)) return false;
    const host = loadSavedHost();
    if (host === null) return false;
    await shell.openExternal(host);
    return true;
  });
  ipcMain.handle("jarvis-companion:minimize", (event) => {
    if (!isBubbleSender(event)) return;
    bubbleWindow?.hide();
  });
  ipcMain.handle("jarvis-companion:test-voice", async (event) => {
    if (!isBubbleSender(event))
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    await speakNativeSpeech("Jarvis Companion voice is ready.");
    return { ok: true };
  });
  ipcMain.handle("jarvis-companion:set-attention-target", (event, target: unknown) => {
    if (
      !isRelaySender(event) ||
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
  ipcMain.handle("jarvis-companion:task-status", (event, status: unknown) => {
    if (!isRelaySender(event)) return;
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
  ipcMain.handle(SPEAK_CHANNEL, async (event, text: unknown) => {
    if (!isRelaySender(event)) return;
    if (typeof text !== "string" || text.trim().length === 0) return;
    await speakNativeSpeech(text.trim());
  });
  ipcMain.handle(REPORT_RELAY_STATUS_CHANNEL, (event, available: unknown) => {
    if (!isRelaySender(event)) return { accepted: false };
    if (typeof available !== "boolean") return { accepted: false };
    reportRelayAvailable = available;
    refreshTrayMenu();
    return { accepted: true };
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
    startOneShotCapture();
  });
  app.whenReady().then(() => {
    start();
    const launch = resolveCompanionLaunch({ argv: process.argv, savedHost: loadSavedHost() });
    if (launch.kind === "pairing") void pairHost(launch.url);
  });
}

app.on("will-quit", () => {
  detachPushToTalk?.();
  globalShortcut.unregisterAll();
});
