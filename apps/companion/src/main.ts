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
  getCompanionProjectCatalog,
  getCompanionProviderCatalog,
  pairCompanionHost,
  submitCompanionTask,
  type CompanionModelSelection,
  type CompanionProjectTarget,
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
import {
  voiceOverlayAutoHideDelay,
  voiceOverlaySpeechGraceDelay,
  voiceOverlaySize,
  voiceOverlaySizeForStatus,
} from "./voice-overlay.ts";
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
  withoutCompanionProject,
  withCompanionConversationMode,
  withCompanionAttentionTarget,
  withCompanionDefault,
  withCompanionHost,
  withCompanionProject,
  type CompanionConversationMode,
  type CompanionSettings,
} from "./settings.ts";
import { isTrustedRelayNavigation } from "./relay-security.ts";
import {
  companionContinuationTarget,
  companionTranscriptHasProjectCue,
  explicitlyStartsNewCompanionTask,
  resolveCompanionProjectTarget,
} from "./voice-routing.ts";

const APP_NAME = "Jarvis Companion";
const PAIR_CHANNEL = "jarvis-companion:pair";
const RECOGNIZE_CHANNEL = "jarvis-companion:recognize";
const SPEAK_CHANNEL = "jarvis-companion:speak";
const SUBMIT_TRANSCRIPT_CHANNEL = "jarvis-companion:submit-transcript";
const CAPTURE_START_CHANNEL = "jarvis-companion:capture-start";
const CAPTURE_STOP_CHANNEL = "jarvis-companion:capture-stop";
const BUBBLE_READY_CHANNEL = "jarvis-companion:bubble-ready";
const STATUS_CHANNEL = "jarvis-companion:status";
const FINISH_STATUS_CHANNEL = "jarvis-companion:finish-task-status";
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
let attentionTarget: CompanionSettings["attentionTarget"];
let knownProjectTargets = new Map<string, CompanionProjectTarget>();
let latestRelayStatusId: string | undefined;
let shortcutRegistered = false;
let hotkeyMode: "hold" | "tap" | "unavailable" = "unavailable";
let detachPushToTalk: (() => void) | undefined;
let reportRelayAvailable = false;
let surface: "voice" | "setup" | undefined;
type CompanionVoiceStatus = {
  readonly state: string;
  readonly detail: string;
  readonly kind: string;
  readonly context?: string;
  readonly stream?: boolean;
  readonly statusId?: string;
};
let latestBubbleStatus: CompanionVoiceStatus | undefined;
let pendingProjectTask:
  | {
      readonly transcript: string;
      readonly projects: ReadonlyArray<CompanionProjectTarget>;
    }
  | undefined;

const setupWindowSize = { width: 536, height: 574 } as const;

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

function rememberAttentionTarget(target: NonNullable<CompanionSettings["attentionTarget"]>) {
  attentionTarget = target;
  saveCompanionSettings(withCompanionAttentionTarget(loadCompanionSettings(), target));
}

function loadSavedHost(): string | null {
  return loadCompanionSettings().host;
}

function loadSavedDefault(): CompanionModelSelection | undefined {
  return loadCompanionSettings().defaultModelSelection;
}

function loadSavedProject() {
  return loadCompanionSettings().projectTarget;
}

function rememberProjectTargets(projects: ReadonlyArray<CompanionProjectTarget>) {
  knownProjectTargets = new Map(projects.map((project) => [project.id, project]));
}

function projectTargetContext(project: CompanionProjectTarget): string {
  return `${project.title} · ${project.workspaceRoot}`;
}

async function resolveProjectContext(projectId: string): Promise<string | undefined> {
  const savedProject = loadSavedProject();
  if (savedProject?.id === projectId) return projectTargetContext(savedProject);
  const knownProject = knownProjectTargets.get(projectId);
  if (knownProject !== undefined) return projectTargetContext(knownProject);
  const host = loadSavedHost();
  if (host === null) return undefined;
  const catalog = await getCompanionProjectCatalog({ fetch: hostFetch, host });
  if (catalog.kind === "error" || loadSavedHost() !== host) return undefined;
  rememberProjectTargets(catalog.projects);
  const project = knownProjectTargets.get(projectId);
  return project === undefined ? undefined : projectTargetContext(project);
}

async function resolveProjectTargetById(
  projectId: string,
): Promise<CompanionProjectTarget | undefined> {
  const savedProject = loadSavedProject();
  if (savedProject?.id === projectId) return savedProject;
  const known = knownProjectTargets.get(projectId);
  if (known !== undefined) return known;
  const host = loadSavedHost();
  if (host === null) return undefined;
  const catalog = await getCompanionProjectCatalog({ fetch: hostFetch, host });
  if (catalog.kind === "error" || loadSavedHost() !== host) return undefined;
  rememberProjectTargets(catalog.projects);
  return knownProjectTargets.get(projectId);
}

function loadConversationMode(): CompanionConversationMode {
  return loadCompanionSettings().conversationMode ?? "new-thread";
}

function saveHost(host: string | null) {
  const current = loadCompanionSettings();
  if (current.host !== host) knownProjectTargets.clear();
  saveCompanionSettings(withCompanionHost(current, host));
}

function saveDefault(selection: CompanionModelSelection) {
  saveCompanionSettings(withCompanionDefault(loadCompanionSettings(), selection));
}

function saveConversationMode(conversationMode: CompanionConversationMode) {
  saveCompanionSettings(withCompanionConversationMode(loadCompanionSettings(), conversationMode));
}

function saveProject(projectTarget: Parameters<typeof withCompanionProject>[1]) {
  saveCompanionSettings(withCompanionProject(loadCompanionSettings(), projectTarget));
}

function clearSavedDefault() {
  saveCompanionSettings(withoutCompanionDefault(loadCompanionSettings()));
}

function clearRememberedProject() {
  saveCompanionSettings(withoutCompanionProject(loadCompanionSettings()));
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
      ? `<main class="voice-surface" aria-label="Jarvis voice command status" aria-live="polite"><div class="voice-presence" role="img" aria-labelledby="presence-state"><span class="presence-halo" aria-hidden="true"></span><span class="presence-orb" aria-hidden="true"><span class="orb-layer orb-bed"></span><span class="orb-layer orb-current"></span><span class="orb-layer orb-caustic"></span><span class="orb-core"></span></span><span id="presence-state" class="visually-hidden">Ready</span></div><section class="voice-copy"><p id="state">Ready when you are</p><p id="detail">Hold the shortcut and tell me what you need.</p><p id="context-line" class="voice-context" hidden><span class="context-mark" aria-hidden="true"></span><span id="context"></span></p></section><div class="voice-hint" aria-label="Voice shortcut"><span id="hint">Hold to talk</span><kbd>Ctrl + Shift + J</kbd></div></main>`
      : `<main class="setup-surface" aria-labelledby="setup-title"><header class="setup-header"><div><p class="product-label">JARVIS / COMPANION</p><h1 id="setup-title">Voice defaults</h1></div><div class="window-controls"><button class="window-button" id="minimize" type="button" aria-label="Minimize Jarvis Companion to the system tray">—</button></div></header><section class="connection-line" aria-label="Connection status"><span id="connection-state" class="connection-state">CHECKING</span><span id="connection-host">Jarvis Host</span></section><p class="setup-intro">Choose what the laptop should use when this PC sends a spoken task.</p><form class="defaults-panel" id="defaults-panel" aria-labelledby="defaults-heading"><div class="section-heading"><p id="defaults-heading">REQUEST DEFAULTS</p><span id="defaults-note">Loading available providers…</span></div><div class="field-grid"><label class="field" for="provider"><span>Provider</span><select id="provider" disabled aria-describedby="setup-message"></select></label><label class="field" for="model"><span>Model</span><select id="model" disabled aria-describedby="setup-message"></select></label><label class="field" id="effort-field" for="effort" hidden><span id="effort-label">Reasoning / effort</span><select id="effort" aria-describedby="setup-message"></select></label><label class="field" id="conversation-field" for="conversation-mode"><span>Conversation</span><select id="conversation-mode" aria-describedby="setup-message"><option value="new-thread">Start a new thread</option><option value="continue-last-thread">Continue latest Jarvis thread</option></select></label></div><p id="selection-summary" class="selection-summary">New requests use the Jarvis Host default.</p><div class="defaults-actions"><button class="primary-button" id="save-defaults" type="submit" disabled>Save defaults</button><button class="secondary-button" id="test-voice" type="button">Test voice</button><button class="link-button" id="open-host-settings" type="button">Open Jarvis Host</button></div></form><section class="empty-provider" id="empty-provider" hidden aria-labelledby="empty-provider-title"><p class="empty-kicker">HOST ACTION NEEDED</p><h2 id="empty-provider-title">No ready provider on Jarvis Host</h2><p>Finish provider setup on the laptop, then reopen this panel. This PC only records and relays your request.</p><button class="secondary-button" id="open-host-empty" type="button">Open host settings</button></section><section class="pairing-panel" id="pairing-panel" hidden aria-labelledby="pairing-title"><div class="section-heading"><p id="pairing-title">PAIR THIS PC</p><span>PRIVATE TAILNET LINK</span></div><form id="pair-form" novalidate><label class="field" for="link"><span>Pairing URL</span><input id="link" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://jarvis-host…/pair#token=…" aria-describedby="link-help setup-message" autofocus /></label><p class="helper" id="link-help">Paste the complete URL, including <code>/pair#token=</code>.</p><button class="primary-button" id="connect" type="submit">Connect companion</button></form></section><p class="setup-message" id="setup-message" role="status" aria-live="polite">Ready.</p><footer><span>RUNS LOCALLY</span><i aria-hidden="true">·</i><span>NO AGENTS RUN ON THIS PC</span><button class="tray-button" id="minimize-footer" type="button">Minimize to tray</button></footer></main>`;
  const script =
    nextSurface === "voice"
      ? `const presenceState=document.querySelector('#presence-state');const state=document.querySelector('#state');const detail=document.querySelector('#detail');const contextLine=document.querySelector('#context-line');const context=document.querySelector('#context');const hint=document.querySelector('#hint');const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');let renderVersion=0;let revealFrame=0;const stateLabel=kind=>({arming:'Preparing',listening:'Listening',capturing:'Listening',checking:'Checking what I heard',review:'Reviewing your request',routing:'Choosing the right workspace',started:'Working',completed:'Complete',attention:'Waiting for you',error:'Something went wrong'}[kind]||'Ready');const naturalTitle=(kind,value)=>{const title=typeof value==='string'?value.trim():'';if(title&&!['On it.','On it','All set.','All set','Voice command ready'].includes(title))return title;return {arming:'Give me a moment',listening:'I’m listening',capturing:'I’m still listening',checking:'Let me make sure I heard that right',review:'Here’s what I heard',routing:'Finding the right place for this',started:'I’ve got it from here',completed:'Finished — here’s the useful part',attention:'I need your call on one thing',error:'I hit a snag'}[kind]||'Ready when you are'};const actionHint=kind=>({arming:'Waking up',listening:'Release to send',capturing:'Release to send',checking:'Checking the words',review:'Review before sending',routing:'Routing safely',started:'Working quietly',completed:'Open T3 to review',attention:'Open T3 to respond',error:'Try that once more'}[kind]||'Hold to talk');const setDetail=(text,stream,version)=>{cancelAnimationFrame(revealFrame);revealFrame=0;detail.title=text;detail.setAttribute('aria-label',text);if(!stream||reducedMotion.matches){detail.textContent=text;detail.removeAttribute('aria-busy');return}const words=text.match(/\\S+\\s*/gu)||[text];detail.textContent='';detail.setAttribute('aria-busy','true');const started=performance.now();const reveal=now=>{if(version!==renderVersion)return;const count=Math.min(words.length,Math.max(1,Math.floor((now-started)/42)+1));detail.textContent=words.slice(0,count).join('');if(count<words.length){revealFrame=requestAnimationFrame(reveal);return}detail.removeAttribute('aria-busy');revealFrame=0};revealFrame=requestAnimationFrame(reveal)};const updateCopy=(next,version)=>{const kind=next.kind||'ready';const text=typeof next.detail==='string'&&next.detail.trim()?next.detail:'Hold the shortcut and tell me what you need.';const project=typeof next.context==='string'?next.context.trim():'';document.body.dataset.state=kind;presenceState.textContent=stateLabel(kind);state.textContent=naturalTitle(kind,next.state);context.textContent=project;contextLine.hidden=!project;hint.textContent=actionHint(kind);setDetail(text,next.stream===true,version);if(kind==='listening'||kind==='capturing')detail.scrollTop=detail.scrollHeight};const render=next=>{const version=++renderVersion;cancelAnimationFrame(revealFrame);revealFrame=0;const canAnimate=!reducedMotion.matches&&detail.textContent.trim().length>0;if(!canAnimate){updateCopy(next,version);return}const outgoing=[state,detail,contextLine].filter(element=>!element.hidden).map(element=>element.animate([{opacity:1,transform:'translate3d(0,0,0)'},{opacity:0,transform:'translate3d(0,-3px,0)'}],{duration:90,easing:'ease-out',fill:'forwards'}).finished.catch(()=>undefined));void Promise.all(outgoing).then(()=>{if(version!==renderVersion)return;[state,detail,contextLine].forEach(element=>element.getAnimations().forEach(animation=>animation.cancel()));updateCopy(next,version);[state,detail,contextLine].filter(element=>!element.hidden).forEach((element,index)=>element.animate([{opacity:0,transform:'translate3d(0,4px,0)'},{opacity:1,transform:'translate3d(0,0,0)'}],{duration:180,delay:index*22,easing:'cubic-bezier(.2,.75,.25,1)'}))})};window.addEventListener('t3code:jarvis-capture-start',()=>render({state:'I’m listening',detail:'Go ahead — I’ll send it when you release the shortcut.',kind:'listening'}));window.addEventListener('t3code:jarvis-capture-stop',()=>render({state:'Let me make sure I heard that right',detail:'Catching the last few words…',kind:'checking'}));window.addEventListener('t3code:jarvis-status',event=>render(event.detail||{}));reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches&&detail.getAttribute('aria-busy')==='true'){renderVersion+=1;cancelAnimationFrame(revealFrame);detail.textContent=detail.getAttribute('aria-label')||'';detail.removeAttribute('aria-busy')}});void window.jarvisCompanion.bubbleReady();`
      : `const initial=${initialSetup};const api=window.jarvisCompanion;const byId=id=>document.getElementById(id);const defaultsPanel=byId('defaults-panel');const defaultsForm=defaultsPanel;const emptyProvider=byId('empty-provider');const pairingPanel=byId('pairing-panel');const provider=byId('provider');const model=byId('model');const effort=byId('effort');const effortField=byId('effort-field');const effortLabel=byId('effort-label');const summary=byId('selection-summary');const note=byId('defaults-note');const message=byId('setup-message');const connectionState=byId('connection-state');const connectionHost=byId('connection-host');const save=byId('save-defaults');const link=byId('link');const connect=byId('connect');let setupData=null;let descriptor=null;const setMessage=(text,kind='ready')=>{message.textContent=text;message.dataset.kind=kind;message.setAttribute('role',kind==='error'?'alert':'status')};const invoke=(name,...args)=>typeof api[name]==='function'?api[name](...args):undefined;const text=value=>typeof value==='string'?value.trim():'';const selectValue=item=>text(item&&((item.slug??item.id??item.value??item.name??item.model)));const providerValue=item=>text(item&&((item.instanceId??item.id??item.name)));const providerLabel=item=>text(item&&((item.displayName??item.label??item.name??item.instanceId)))||'Provider';const modelsFor=providerItem=>Array.isArray(providerItem&&providerItem.models)?providerItem.models:[];const optionDescriptors=modelItem=>{const capabilities=modelItem&&modelItem.capabilities;const values=capabilities&&capabilities.optionDescriptors||modelItem&&modelItem.optionDescriptors;return Array.isArray(values)?values:[]};const optionItems=item=>Array.isArray(item&&item.options)?item.options:[];const optionValue=item=>text(item&&((item.value??item.id??item.name)));const optionLabel=item=>text(item&&((item.label??item.name??item.value??item.id)));const clearSelect=element=>{element.replaceChildren()};const addOption=(element,value,label)=>{const item=document.createElement('option');item.value=value;item.textContent=label;element.append(item)};const selectedProvider=()=>Array.isArray(setupData&&setupData.providers)?setupData.providers.find(item=>providerValue(item)===provider.value):undefined;const selectedModel=()=>modelsFor(selectedProvider()).find(item=>selectValue(item)===model.value);const updateSummary=()=>{const name=provider.options[provider.selectedIndex]&&provider.options[provider.selectedIndex].textContent||'Jarvis Host';const modelName=model.options[model.selectedIndex]&&model.options[model.selectedIndex].textContent||'default model';const effortName=!effortField.hidden&&effort.options[effort.selectedIndex]&&effort.options[effort.selectedIndex].textContent;summary.textContent='New requests use '+name+' / '+modelName+(effortName?' / '+effortName+'.':'.')};const renderEffort=selection=>{const descriptors=optionDescriptors(selectedModel());descriptor=descriptors.find(item=>/reason|effort|thinking/i.test(text(item&&((item.id??item.name??item.label)))))||descriptors.find(item=>optionItems(item).length>0);if(!descriptor){effortField.hidden=true;clearSelect(effort);return}const items=optionItems(descriptor);if(!items.length){effortField.hidden=true;return}effortField.hidden=false;effortLabel.textContent=text(descriptor.label??descriptor.name)||'Reasoning / effort';clearSelect(effort);items.forEach(item=>addOption(effort,optionValue(item),optionLabel(item)));const existing=Array.isArray(selection&&selection.options)?selection.options.find(item=>text(item&&item.id)===text(descriptor.id)):undefined;const selected=text(existing&&existing.value);if(selected&&Array.from(effort.options).some(item=>item.value===selected))effort.value=selected};const renderModels=selection=>{clearSelect(model);const models=modelsFor(selectedProvider());models.forEach(item=>addOption(model,selectValue(item),text(item.shortName??item.displayName??item.label??item.name??item.model??item.id)||'Model'));const selected=text(selection&&selection.model);if(selected&&Array.from(model.options).some(item=>item.value===selected))model.value=selected;model.disabled=models.length===0;renderEffort(selection);updateSummary()};const renderProviders=data=>{setupData=data;const all=Array.isArray(data&&data.providers)?data.providers:[];const ready=all.filter(item=>item&&item.status==='ready'&&item.enabled!==false&&item.installed!==false&&(!item.auth||item.auth.status!=='unauthenticated')&&modelsFor(item).length>0);if(!ready.length){defaultsPanel.hidden=true;emptyProvider.hidden=false;return}setupData={...data,providers:ready};defaultsPanel.hidden=false;emptyProvider.hidden=true;clearSelect(provider);ready.forEach(item=>addOption(provider,providerValue(item),providerLabel(item)));const selection=data.defaultModelSelection||data.defaultSelection||data.selection||null;const selected=text(selection&&selection.instanceId);if(selected&&Array.from(provider.options).some(item=>item.value===selected))provider.value=selected;provider.disabled=false;renderModels(selection);save.disabled=false;note.textContent='Saved choices are sent with every spoken request.'};const showConnection=host=>{const value=host===undefined?initial.host:text(host);const connected=Boolean(value);connectionState.textContent=connected?'CONNECTED':'NOT CONNECTED';connectionState.dataset.connected=connected?'true':'false';connectionHost.textContent=connected?value:'Pair with Jarvis Host to continue.';pairingPanel.hidden=connected;defaultsPanel.hidden=!connected;emptyProvider.hidden=true;if(!connected){setMessage('Paste a fresh pairing URL from Jarvis Host.');link.focus()}};const openHost=async()=>{const opened=await invoke('openHost');if(opened===undefined)setMessage('Open Jarvis Host from the companion tray menu.','ready')};const minimize=()=>{const result=invoke('minimize');if(result===undefined)window.close()};const saveDefaults=async()=>{if(!setupData)return;save.disabled=true;setMessage('Saving defaults to this companion…','progress');const selection={instanceId:provider.value,model:model.value,...(!effortField.hidden&&descriptor?{options:[{id:text(descriptor.id),value:effort.value}]}:{})};try{const result=await invoke('saveDefault',selection);if(result===undefined){setMessage('This companion build cannot save defaults yet. Install the current release.','error');return}if(!result.ok){setMessage(result.message||'Jarvis Host rejected those defaults.','error');return}setMessage('Defaults saved. Your next voice request is ready.','success')}catch{setMessage('Defaults could not be saved. Try again.','error')}finally{save.disabled=false}};const initialize=async()=>{showConnection(initial.host);if(!initial.configured)return;setMessage('Checking available providers…','progress');const result=await invoke('getSetup');if(result===undefined){defaultsPanel.hidden=true;emptyProvider.hidden=false;setMessage('Provider defaults will be available after the companion finishes updating.','ready');return}if(!result||result.ok===false){if(result&&result.needsPairing){showConnection(null);setMessage(result.message||'This companion needs a fresh pairing URL from Jarvis Host.','error');return}defaultsPanel.hidden=true;emptyProvider.hidden=false;setMessage(result&&result.message||'Jarvis Host could not load provider defaults.','error');return}if(result.connected===false){showConnection(null);return}showConnection(result.host||initial.host);renderProviders(result);setMessage('Ready to save voice defaults.','success')};provider.addEventListener('change',()=>renderModels(null));model.addEventListener('change',()=>{renderEffort(null);updateSummary()});effort.addEventListener('change',updateSummary);defaultsForm.addEventListener('submit',event=>{event.preventDefault();void saveDefaults()});byId('test-voice').addEventListener('click',async()=>{setMessage('Testing Jarvis voice…','progress');try{const result=await invoke('testVoice');if(result===undefined)await api.speak('Jarvis Companion voice is ready.');setMessage('Voice test sent.','success')}catch{setMessage('Voice test could not start.','error')}});[byId('open-host-settings'),byId('open-host-empty')].filter(Boolean).forEach(button=>button.addEventListener('click',()=>void openHost()));[byId('minimize'),byId('minimize-footer')].filter(Boolean).forEach(button=>button.addEventListener('click',minimize));byId('pair-form').addEventListener('submit',async event=>{event.preventDefault();const candidate=link.value.trim();link.removeAttribute('aria-invalid');if(!candidate){link.setAttribute('aria-invalid','true');setMessage('Paste the complete Jarvis pairing URL.','error');link.focus();return}connect.disabled=true;connect.textContent='Connecting…';setMessage('Verifying the private connection…','progress');try{const result=await api.submitPairingLink(candidate);if(!result.ok){link.setAttribute('aria-invalid','true');setMessage(result.message||'Jarvis could not complete that connection. Try a fresh pairing URL.','error');link.focus()}}catch{link.setAttribute('aria-invalid','true');setMessage('Jarvis could not complete that connection. Check the URL and try again.','error')}finally{connect.disabled=false;connect.textContent='Connect companion'}});link.addEventListener('input',()=>{link.removeAttribute('aria-invalid');setMessage('Ready to verify the private connection.')});window.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();minimize()}});void initialize();`;
  const voiceSurfaceStyle =
    nextSurface === "voice"
      ? `<style>.voice-surface{--orb-deep:#173540;--orb-mid:#426f83;--orb-light:#a8d0d9;--orb-silt:#78a6b4;position:relative;width:100%;height:100%;display:grid;grid-template-columns:62px minmax(0,1fr) 112px;align-items:center;gap:11px;padding:10px 15px 10px 11px;overflow:hidden;border:1px solid rgba(201,214,220,.13);border-radius:25px 15px 15px 25px;background:rgba(16,18,21,.91);box-shadow:0 14px 34px rgba(0,0,0,.34);isolation:isolate}.voice-orb{position:relative;display:grid;place-items:center;width:57px;height:57px;overflow:hidden;border:1px solid rgba(210,227,230,.23);border-radius:48% 52% 50% 50% / 49% 47% 53% 51%;background:var(--orb-deep);box-shadow:inset 3px 4px 12px rgba(225,247,246,.13),inset -7px -9px 15px rgba(5,17,23,.37),0 5px 15px rgba(0,0,0,.26);isolation:isolate}.orb-layer{position:absolute;inset:-26%;display:block;border-radius:49% 51% 48% 52% / 44% 55% 45% 56%;pointer-events:none}.orb-bed{background:radial-gradient(circle at 29% 26%,var(--orb-light) 0 3%,rgba(179,218,221,.54) 15%,transparent 33%),radial-gradient(circle at 64% 73%,var(--orb-silt) 0 14%,transparent 42%),linear-gradient(145deg,var(--orb-mid),var(--orb-deep) 70%);opacity:.94}.orb-current{inset:-39%;background:radial-gradient(ellipse at 33% 46%,rgba(205,237,235,.48) 0 10%,transparent 27%),radial-gradient(ellipse at 66% 66%,rgba(45,105,125,.65) 0 18%,transparent 42%);mix-blend-mode:screen;opacity:.58;transform:translate3d(-3%,2%,0) rotate(-13deg)}.orb-caustic{inset:-16%;background:radial-gradient(ellipse at 28% 64%,rgba(236,249,244,.34) 0 4%,transparent 17%),radial-gradient(ellipse at 68% 28%,rgba(196,230,230,.23) 0 5%,transparent 20%);opacity:.64;transform:rotate(22deg)}.orb-core{position:relative;z-index:1;width:8px;height:8px;border-radius:50%;background:rgba(237,250,246,.81);box-shadow:0 0 0 3px rgba(233,250,248,.08)}.orb-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}.voice-copy{position:relative;z-index:1;min-width:0;align-self:center;user-select:text;-webkit-user-select:text;-webkit-app-region:no-drag}.voice-copy p{margin:0}.voice-copy #state{color:#f1f0ea;font-size:13px;font-weight:625;letter-spacing:-.12px;line-height:18px}.voice-copy #detail{display:-webkit-box;max-height:31px;overflow:hidden;color:#aeb8bd;font-size:12px;line-height:15px;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}.voice-hint{display:flex;flex-direction:column;justify-content:center;align-items:flex-end;gap:4px;min-width:0;color:#717d83;text-align:right}.voice-hint span{font:600 10px var(--ui);line-height:14px}.voice-hint kbd{padding:0;border:0;background:none;color:#8d999f;font:10px var(--mono);white-space:nowrap}.voice-surface:has(#detail:focus-visible){border-color:rgba(164,206,217,.48)}body[data-state="listening"] .voice-surface,body[data-state="capturing"] .voice-surface{--orb-deep:#173b49;--orb-mid:#52889b;--orb-light:#bfdee3;--orb-silt:#7caab6}body[data-state="listening"] .orb-current,body[data-state="capturing"] .orb-current{animation:jarvis-water-drift 8s ease-in-out 1 alternate both}body[data-state="listening"] .orb-caustic,body[data-state="capturing"] .orb-caustic{animation:jarvis-water-glint 11s ease-in-out 1 alternate both}body[data-state="checking"] .voice-surface,body[data-state="review"] .voice-surface,body[data-state="routing"] .voice-surface{--orb-deep:#453a27;--orb-mid:#876e45;--orb-light:#dbc28f;--orb-silt:#a98d5b}body[data-state="started"] .voice-surface{--orb-deep:#1e4038;--orb-mid:#527e71;--orb-light:#b1d5c5;--orb-silt:#7fa893}body[data-state="error"] .voice-surface{--orb-deep:#472d2d;--orb-mid:#87564f;--orb-light:#e0aaa2;--orb-silt:#aa726b}body[data-state="error"] .voice-copy #state{color:#f0c4c0}body[data-state="review"] .voice-surface{align-items:start;grid-template-columns:62px minmax(0,1fr) 112px;padding-top:14px;padding-bottom:14px}body[data-state="review"] .voice-orb{margin-top:1px}body[data-state="review"] .voice-copy{align-self:stretch;padding-top:1px}body[data-state="review"] .voice-copy #detail{display:block;max-height:194px;overflow-y:auto;padding-right:7px;-webkit-line-clamp:unset;overscroll-behavior:contain;scrollbar-color:#667880 transparent}body[data-state="review"] .voice-hint{align-self:start;padding-top:2px}@keyframes jarvis-water-drift{from{transform:translate3d(-5%,3%,0) rotate(-15deg) scale(1.01)}to{transform:translate3d(5%,-4%,0) rotate(15deg) scale(1.07)}}@keyframes jarvis-water-glint{from{opacity:.38;transform:translate3d(-2%,2%,0) rotate(11deg)}to{opacity:.72;transform:translate3d(3%,-2%,0) rotate(29deg)}}@media (prefers-reduced-motion:reduce){.orb-current,.orb-caustic{animation:none!important}}</style>`
      : "";
  const voiceSurfaceRefinementStyle =
    nextSurface === "voice"
      ? `<style>.voice-surface{grid-template-columns:72px minmax(0,1fr) 70px;gap:0;padding:10px 13px 10px 10px;overflow:visible;border:0;border-radius:0;background:transparent;box-shadow:none}.voice-orb{z-index:2;width:66px;height:66px;border-color:rgba(211,229,231,.27);box-shadow:inset 3px 4px 12px rgba(225,247,246,.15),inset -7px -9px 15px rgba(5,17,23,.39),0 7px 18px rgba(0,0,0,.31)}.voice-copy{z-index:1;min-height:60px;margin-left:-35px;padding:12px 14px 11px 43px;border:1px solid rgba(190,205,211,.11);border-left:0;border-radius:0 17px 17px 0;background:rgba(17,21,24,.77);box-shadow:0 8px 22px rgba(0,0,0,.21)}.voice-copy::before{position:absolute;inset:12px auto 12px 25px;width:1px;background:rgba(175,212,220,.18);content:""}.voice-hint{z-index:1;min-width:0;padding-left:9px;align-self:center}.voice-hint kbd{font-size:9px}body[data-state="listening"] .voice-surface,body[data-state="capturing"] .voice-surface{align-items:start;padding-top:10px;padding-bottom:10px}body[data-state="listening"] .voice-copy,body[data-state="capturing"] .voice-copy{align-self:start;min-height:68px}body[data-state="listening"] .voice-copy #detail,body[data-state="capturing"] .voice-copy #detail{display:block;max-height:62px;overflow-y:auto;padding-right:6px;-webkit-line-clamp:unset;overscroll-behavior:contain;scrollbar-color:#667f89 transparent}body[data-state="listening"] .voice-hint,body[data-state="capturing"] .voice-hint{align-self:start;padding-top:12px}@media (max-width:420px){.voice-surface{grid-template-columns:58px minmax(0,1fr);padding-right:9px}.voice-orb{width:52px;height:52px}.voice-copy{min-height:58px;margin-left:-25px;padding:11px 72px 10px 33px;border-radius:0 14px 14px 0}.voice-copy::before{inset:11px auto 11px 19px}.voice-hint{position:absolute;right:15px;bottom:17px;padding:0;pointer-events:none}.voice-hint span{display:none}.voice-hint kbd{font-size:9px}body[data-state="listening"] .voice-hint,body[data-state="capturing"] .voice-hint{top:15px;bottom:auto;padding-top:0}body[data-state="listening"] .voice-copy,body[data-state="capturing"] .voice-copy{padding-right:14px}}</style>`
      : "";
  const voiceReviewStyle =
    nextSurface === "voice"
      ? `<style>body[data-state="review"] .voice-copy #detail,body[data-state="attention"] .voice-copy #detail{display:block;max-height:194px;overflow-y:auto;overscroll-behavior:contain;padding-right:7px;-webkit-line-clamp:unset;scrollbar-color:#667880 transparent}</style>`
      : "";
  const voiceCinematicStyle =
    nextSurface === "voice"
      ? `<style>
.visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.voice-surface{--orb-deep:#102f39;--orb-mid:#42798a;--orb-light:#c0e1e1;--orb-silt:#6ea5b2;--orb-bloom:rgba(119,206,215,.20);--flow-duration:13s;--glint-duration:17s;--halo-duration:7s;position:relative;width:100%;height:100%;display:grid;grid-template-columns:70px minmax(0,1fr) 100px;align-items:center;gap:10px;padding:10px 14px 10px 10px;overflow:hidden;border:1px solid rgba(201,225,229,.15);border-radius:23px 15px 15px 23px;background:radial-gradient(120% 180% at 3% 8%,rgba(71,119,128,.18),transparent 42%),linear-gradient(112deg,rgba(17,27,31,.97),rgba(11,16,20,.97) 62%,rgba(17,22,25,.96));box-shadow:inset 0 1px rgba(235,249,247,.09),inset 0 -1px rgba(0,0,0,.44),0 15px 38px rgba(0,0,0,.38);isolation:isolate}
.voice-surface::before{position:absolute;inset:0;z-index:-1;pointer-events:none;background:repeating-linear-gradient(113deg,rgba(232,247,246,.018) 0 1px,transparent 1px 5px),radial-gradient(circle at 71% 26%,rgba(140,190,196,.055) 0 1px,transparent 1.4px);background-size:auto,7px 7px;opacity:.72;content:""}
.voice-surface::after{position:absolute;inset:1px;z-index:-1;pointer-events:none;border-radius:22px 14px 14px 22px;box-shadow:inset 16px 0 28px rgba(89,151,160,.035),inset -18px 0 32px rgba(0,0,0,.16);content:""}
.voice-presence{position:relative;z-index:2;display:grid;place-items:center;width:64px;height:64px;isolation:isolate}
.presence-halo{position:absolute;inset:7px;border-radius:47% 53% 48% 52%/52% 44% 56% 48%;background:var(--orb-bloom);opacity:.68;transform:scale(.94);animation:jarvis-halo var(--halo-duration) ease-in-out 1 alternate both;pointer-events:none}
.presence-orb{position:relative;display:grid;place-items:center;width:56px;height:56px;overflow:hidden;border:1px solid rgba(219,240,240,.25);border-radius:48% 52% 51% 49%/47% 46% 54% 53%;background:var(--orb-deep);box-shadow:inset 3px 4px 13px rgba(225,249,246,.15),inset -8px -10px 17px rgba(2,13,18,.48),0 7px 18px rgba(0,0,0,.3);isolation:isolate}
.orb-layer{position:absolute;display:block;pointer-events:none}
.orb-bed{inset:-24%;border-radius:49% 51% 48% 52%/44% 55% 45% 56%;background:radial-gradient(circle at 29% 25%,var(--orb-light) 0 3%,rgba(188,224,225,.55) 14%,transparent 32%),radial-gradient(circle at 65% 73%,var(--orb-silt) 0 13%,transparent 43%),linear-gradient(145deg,var(--orb-mid),var(--orb-deep) 71%);opacity:.94}
.orb-current{inset:-37%;border-radius:46% 54% 50% 50%/54% 44% 56% 46%;background:radial-gradient(ellipse at 34% 45%,rgba(218,241,238,.49) 0 9%,transparent 27%),radial-gradient(ellipse at 66% 67%,rgba(46,115,132,.68) 0 17%,transparent 42%);mix-blend-mode:screen;animation:jarvis-current var(--flow-duration) cubic-bezier(.45,.05,.55,.95) 1 alternate both}
.orb-caustic{inset:-15%;border-radius:53% 47% 52% 48%/48% 54% 46% 52%;background:radial-gradient(ellipse at 27% 65%,rgba(242,251,246,.38) 0 4%,transparent 17%),radial-gradient(ellipse at 70% 27%,rgba(203,235,232,.25) 0 5%,transparent 20%);animation:jarvis-caustic var(--glint-duration) ease-in-out 1 alternate both}
.orb-core{position:relative;z-index:1;width:7px;height:7px;border-radius:50%;background:rgba(240,251,247,.88);box-shadow:0 0 0 3px rgba(232,251,247,.07),0 0 13px rgba(189,233,230,.25)}
.voice-copy{position:relative;z-index:1;min-width:0;min-height:58px;display:flex;flex-direction:column;justify-content:center;padding:6px 2px 6px 12px;border-left:1px solid rgba(176,217,222,.16);user-select:text;-webkit-user-select:text;-webkit-app-region:no-drag}
.voice-copy p{margin:0;min-width:0}.voice-copy #state{color:#f0f4ef;font-size:13px;font-weight:640;letter-spacing:-.14px;line-height:18px;text-shadow:0 1px 10px rgba(221,246,242,.05)}
.voice-copy #detail{display:-webkit-box;max-height:30px;overflow:hidden;color:#aebdc0;font-size:12px;font-weight:430;line-height:15px;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.voice-copy #detail:focus-visible{outline:1px solid rgba(157,211,219,.65);outline-offset:3px}
.voice-context{display:flex;align-items:center;gap:6px;margin-top:3px!important;overflow:hidden;color:#7f969b;font:9px/12px var(--mono);letter-spacing:.22px;white-space:nowrap;text-overflow:ellipsis}
.voice-context[hidden]{display:none}.voice-context #context{overflow:hidden;text-overflow:ellipsis}.context-mark{flex:0 0 auto;width:4px;height:4px;border:1px solid rgba(165,213,218,.55);transform:rotate(45deg)}
.voice-hint{position:relative;z-index:1;display:flex;min-width:0;flex-direction:column;justify-content:center;align-items:flex-end;gap:4px;padding-left:7px;color:#74878c;text-align:right}
.voice-hint::before{position:absolute;left:0;width:1px;height:24px;background:linear-gradient(transparent,rgba(165,201,206,.15),transparent);content:""}.voice-hint span{max-width:92px;color:#83979b;font-size:10px;font-weight:590;line-height:12px}.voice-hint kbd{padding:0;border:0;background:none;color:#61757a;font:9px/11px var(--mono);letter-spacing:-.15px;white-space:nowrap}
body[data-state="arming"] .voice-surface,body[data-state="listening"] .voice-surface,body[data-state="capturing"] .voice-surface{--orb-deep:#123642;--orb-mid:#538b9a;--orb-light:#c7e7e6;--orb-silt:#81b5be;--orb-bloom:rgba(115,208,218,.24);--flow-duration:7.5s;--glint-duration:10s;--halo-duration:3.8s}
body[data-state="checking"] .voice-surface,body[data-state="review"] .voice-surface,body[data-state="routing"] .voice-surface{--orb-deep:#403522;--orb-mid:#806b45;--orb-light:#dec998;--orb-silt:#a68b58;--orb-bloom:rgba(188,151,83,.18);--flow-duration:11s;--glint-duration:14s;--halo-duration:5.5s}
body[data-state="started"] .voice-surface{--orb-deep:#163a33;--orb-mid:#4c8275;--orb-light:#bae0cf;--orb-silt:#78ad96;--orb-bloom:rgba(105,194,161,.19);--flow-duration:9s;--glint-duration:13s;--halo-duration:4.8s}
body[data-state="completed"] .voice-surface{--orb-deep:#29443e;--orb-mid:#7aa89a;--orb-light:#edf7ee;--orb-silt:#a9cbbd;--orb-bloom:rgba(186,226,210,.16);--flow-duration:18s;--glint-duration:22s;--halo-duration:9s}
body[data-state="attention"] .voice-surface{--orb-deep:#403523;--orb-mid:#8a7448;--orb-light:#e4cea0;--orb-silt:#b2965e;--orb-bloom:rgba(202,165,91,.2);--flow-duration:8s;--glint-duration:12s;--halo-duration:4.5s}
body[data-state="error"] .voice-surface{--orb-deep:#452b2b;--orb-mid:#87554e;--orb-light:#e3aaa3;--orb-silt:#ad716a;--orb-bloom:rgba(207,103,91,.18);--flow-duration:16s;--glint-duration:20s;--halo-duration:8s}body[data-state="error"] .voice-copy #state{color:#f1c5c0}
body[data-state="review"] .voice-surface,body[data-state="attention"] .voice-surface{grid-template-columns:70px minmax(0,1fr) 100px;align-items:start;padding-top:14px;padding-bottom:14px}body[data-state="review"] .voice-presence,body[data-state="attention"] .voice-presence{margin-top:0}body[data-state="review"] .voice-copy,body[data-state="attention"] .voice-copy{max-height:calc(100vh - 28px);justify-content:flex-start;padding-top:3px;padding-bottom:3px}body[data-state="review"] .voice-copy #detail,body[data-state="attention"] .voice-copy #detail{display:block;max-height:calc(100vh - 67px);overflow-y:auto;padding-right:7px;-webkit-line-clamp:unset;overscroll-behavior:contain;scrollbar-color:#61777b transparent}body[data-state="review"] .voice-hint,body[data-state="attention"] .voice-hint{align-self:start;margin-top:8px}
@keyframes jarvis-current{from{opacity:.48;transform:translate3d(-5%,3%,0) rotate(-15deg) scale(1.01)}to{opacity:.72;transform:translate3d(5%,-4%,0) rotate(15deg) scale(1.07)}}
@keyframes jarvis-caustic{from{opacity:.34;transform:translate3d(-2%,2%,0) rotate(11deg)}to{opacity:.7;transform:translate3d(3%,-2%,0) rotate(29deg)}}
@keyframes jarvis-halo{from{opacity:.34;transform:scale(.9) rotate(-3deg)}to{opacity:.72;transform:scale(1.07) rotate(4deg)}}
@media (max-width:440px){.voice-surface{grid-template-columns:60px minmax(0,1fr) 76px;gap:6px;padding-right:10px}.voice-presence{width:58px;height:58px}.presence-orb{width:52px;height:52px}.voice-copy{padding-left:9px}.voice-hint span{max-width:70px}.voice-hint kbd{font-size:8px}}
@media (prefers-reduced-motion:reduce){.presence-halo,.orb-current,.orb-caustic{animation:none!important}.presence-halo{opacity:.52;transform:none}.orb-current{opacity:.6;transform:rotate(-9deg)}.orb-caustic{opacity:.52;transform:rotate(18deg)}}
</style>`
      : "";
  const voiceReviewScript =
    nextSurface === "voice"
      ? `const updateReviewAffordance=()=>{const reviewing=['review','attention'].includes(document.body.dataset.state);const scrollable=reviewing&&detail.scrollHeight>detail.clientHeight;detail.tabIndex=scrollable?0:-1;if(scrollable)hint.textContent='Scroll to review'};new MutationObserver(updateReviewAffordance).observe(document.body,{attributes:true,attributeFilter:['data-state']});updateReviewAffordance();`
      : "";
  const conversationModeScript =
    nextSurface === "setup"
      ? `<script>(()=>{const mode=document.getElementById('conversation-mode');if(!mode)return;mode.value=${JSON.stringify(loadConversationMode())};mode.addEventListener('change',async()=>{const result=await window.jarvisCompanion.saveConversationMode?.(mode.value);if(!result||!result.ok){mode.value='new-thread';document.getElementById('setup-message').textContent=(result&&result.message)||'Conversation mode could not be saved.'}})})()</script>`
      : "";
  const presentationRepairStyle = `<style>
.voice-surface{--lens-deep:#132b31;--lens-mid:#426f77;--lens-light:#d8eeeb;--lens-mineral:#927958;--lens-bloom:rgba(115,190,195,.17);position:relative;width:100%;height:100%;display:grid;grid-template-columns:64px minmax(0,1fr) 92px;align-items:center;gap:0;padding:9px 11px 9px 8px;overflow:visible;border:0;border-radius:0;background:transparent;box-shadow:none;isolation:isolate}
.voice-surface::before{position:absolute;z-index:-1;inset:12px 6px 12px 38px;border:1px solid rgba(222,235,234,.11);border-radius:5px 17px 17px 5px;background:linear-gradient(108deg,rgba(20,25,27,.88),rgba(14,17,19,.94));box-shadow:0 12px 28px rgba(0,0,0,.3),inset 0 1px rgba(255,255,255,.025);content:""}
.voice-surface::after{position:absolute;z-index:-1;inset:13px 7px auto 48px;height:1px;background:linear-gradient(90deg,rgba(216,237,235,.16),rgba(216,237,235,0) 72%);content:""}
.voice-presence{position:relative;z-index:2;display:grid;place-items:center;width:62px;height:62px;filter:none}
.presence-halo{position:absolute;inset:4px;border-radius:46% 54% 51% 49%/55% 45% 55% 45%;background:radial-gradient(circle,var(--lens-bloom),transparent 69%);opacity:.66;transform:scale(.94);animation:none;pointer-events:none}
.presence-orb{position:relative;display:grid;place-items:center;width:58px;height:58px;overflow:hidden;border:1px solid rgba(221,242,239,.26);border-radius:47% 53% 50% 50%/51% 45% 55% 49%;background:var(--lens-deep);box-shadow:inset 4px 5px 13px rgba(239,255,251,.14),inset -9px -11px 18px rgba(1,11,14,.5),0 7px 17px rgba(0,0,0,.31);isolation:isolate;transition:background-color 180ms ease,border-color 180ms ease}
.presence-orb::before{position:absolute;z-index:2;inset:0;border-radius:inherit;background:repeating-radial-gradient(circle at 34% 31%,rgba(255,255,255,.025) 0 1px,transparent 1px 4px);mix-blend-mode:soft-light;opacity:.7;content:"";pointer-events:none}
.orb-layer{position:absolute;display:block;border-radius:inherit;pointer-events:none;animation:none}
.orb-bed{inset:-22%;background:radial-gradient(circle at 28% 24%,var(--lens-light) 0 3%,rgba(184,221,217,.5) 13%,transparent 31%),radial-gradient(circle at 68% 77%,var(--lens-mineral) 0 5%,transparent 27%),linear-gradient(147deg,var(--lens-mid),var(--lens-deep) 69%);opacity:.93}
.orb-current{inset:-37%;border-radius:44% 56% 50% 50%/55% 43% 57% 45%;background:radial-gradient(ellipse at 36% 43%,rgba(226,246,241,.43) 0 9%,transparent 28%),radial-gradient(ellipse at 69% 69%,rgba(36,100,111,.69) 0 16%,transparent 42%);mix-blend-mode:screen;opacity:.58;transform:translate3d(-3%,2%,0) rotate(-12deg)}
.orb-caustic{inset:-13%;background:radial-gradient(ellipse at 26% 67%,rgba(249,255,249,.42) 0 3%,transparent 16%),radial-gradient(ellipse at 72% 26%,rgba(210,238,233,.24) 0 4%,transparent 20%);opacity:.58;transform:rotate(19deg)}
.orb-core{position:relative;z-index:3;width:5px;height:5px;border-radius:50%;background:rgba(245,255,251,.82);box-shadow:0 0 0 3px rgba(235,254,249,.06),0 0 10px rgba(201,239,233,.23)}
.voice-copy{position:relative;z-index:1;min-width:0;min-height:58px;display:flex;flex-direction:column;justify-content:center;margin:0;padding:8px 10px 8px 13px;border:0;background:transparent;box-shadow:none;user-select:text;-webkit-user-select:text;-webkit-app-region:no-drag}
.voice-copy::before{position:absolute;inset:12px auto 12px 0;width:1px;background:linear-gradient(transparent,rgba(187,219,219,.18),transparent);content:""}
.voice-copy p{margin:0;min-width:0}.voice-copy #state{color:#f0f2ed;font:630 13px/18px var(--ui);letter-spacing:-.13px;text-shadow:none}.voice-copy #detail{display:-webkit-box;max-height:30px;overflow:hidden;color:#aeb9b9;font:420 12px/15px var(--ui);overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}.voice-copy #detail:focus-visible{outline:1px solid rgba(162,203,202,.58);outline-offset:3px}
.voice-context{display:flex;align-items:center;gap:6px;margin-top:2px!important;overflow:hidden;color:#758a89;font:9px/12px var(--mono);letter-spacing:0;white-space:nowrap;text-overflow:ellipsis}.voice-context[hidden]{display:none}.voice-context #context{overflow:hidden;text-overflow:ellipsis}.context-mark{flex:0 0 auto;width:3px;height:3px;border-radius:50%;border:0;background:#718d89;transform:none}
.voice-hint{position:relative;z-index:1;display:flex;min-width:0;flex-direction:column;justify-content:center;align-items:flex-end;gap:3px;padding:0 2px 0 7px;color:#6f807f;text-align:right}.voice-hint::before{display:none}.voice-hint span{max-width:84px;color:#7e908e;font:560 10px/12px var(--ui)}.voice-hint kbd{padding:0;border:0;background:none;color:#566b69;font:9px/11px var(--mono);letter-spacing:-.2px;white-space:nowrap}
body[data-state="arming"] .voice-surface,body[data-state="listening"] .voice-surface,body[data-state="capturing"] .voice-surface{--lens-deep:#102f37;--lens-mid:#53878c;--lens-light:#e2f5f1;--lens-mineral:#9b8058;--lens-bloom:rgba(117,209,207,.23)}
body[data-state="checking"] .voice-surface,body[data-state="review"] .voice-surface,body[data-state="routing"] .voice-surface{--lens-deep:#382f21;--lens-mid:#756442;--lens-light:#e2d2aa;--lens-mineral:#ad8750;--lens-bloom:rgba(190,156,91,.17)}
body[data-state="started"] .voice-surface,body[data-state="completed"] .voice-surface{--lens-deep:#18332d;--lens-mid:#527b6e;--lens-light:#dceee4;--lens-mineral:#8b8361;--lens-bloom:rgba(123,188,158,.17)}
body[data-state="attention"] .voice-surface{--lens-deep:#392f21;--lens-mid:#806d46;--lens-light:#ead8ac;--lens-mineral:#b28b4f;--lens-bloom:rgba(205,169,94,.19)}body[data-state="error"] .voice-surface{--lens-deep:#392727;--lens-mid:#75504b;--lens-light:#e8c0ba;--lens-mineral:#a4695f;--lens-bloom:rgba(194,104,94,.16)}body[data-state="error"] .voice-copy #state{color:#ecc6c1}
body[data-state="listening"] .presence-orb,body[data-state="capturing"] .presence-orb{animation:lens-settle 620ms cubic-bezier(.2,.78,.24,1) 1 both}body[data-state="listening"] .presence-halo,body[data-state="capturing"] .presence-halo{animation:halo-settle 680ms ease-out 1 both}body[data-state="listening"] .orb-current,body[data-state="capturing"] .orb-current{animation:current-settle 820ms cubic-bezier(.2,.72,.25,1) 1 both}body[data-state="checking"] .presence-orb,body[data-state="review"] .presence-orb,body[data-state="routing"] .presence-orb{animation:lens-check 420ms ease-out 1 both}body[data-state="started"] .presence-orb,body[data-state="completed"] .presence-orb{animation:lens-complete 460ms ease-out 1 both}body[data-state="error"] .presence-orb{animation:lens-error 390ms ease-out 1 both}
body[data-state="review"] .voice-surface,body[data-state="attention"] .voice-surface{grid-template-columns:64px minmax(0,1fr) 92px;align-items:start;padding-top:10px;padding-bottom:10px}body[data-state="review"] .voice-presence,body[data-state="attention"] .voice-presence{margin-top:0}body[data-state="review"] .voice-copy,body[data-state="attention"] .voice-copy{max-height:calc(100vh - 20px);justify-content:flex-start;padding-top:3px;padding-bottom:3px}body[data-state="review"] .voice-copy #detail,body[data-state="attention"] .voice-copy #detail{display:block;max-height:calc(100vh - 58px);overflow-y:auto;padding-right:7px;-webkit-line-clamp:unset;overscroll-behavior:contain;scrollbar-color:#536b68 transparent}body[data-state="review"] .voice-hint,body[data-state="attention"] .voice-hint{align-self:start;margin-top:8px}
@keyframes lens-settle{0%{transform:scale(.88) rotate(-2deg);border-radius:55% 45% 48% 52%/42% 57% 43% 58%}58%{transform:scale(1.045) rotate(1deg)}100%{transform:scale(1) rotate(0);border-radius:47% 53% 50% 50%/51% 45% 55% 49%}}@keyframes halo-settle{0%{opacity:0;transform:scale(.72)}55%{opacity:.78;transform:scale(1.08)}100%{opacity:.66;transform:scale(.94)}}@keyframes current-settle{0%{opacity:.25;transform:translate3d(-10%,7%,0) rotate(-25deg)}100%{opacity:.62;transform:translate3d(-3%,2%,0) rotate(-12deg)}}@keyframes lens-check{0%{transform:scale(1)}50%{transform:scale(.955)}100%{transform:scale(1)}}@keyframes lens-complete{0%{filter:brightness(.88)}45%{filter:brightness(1.13)}100%{filter:brightness(1)}}@keyframes lens-error{0%,100%{transform:translateX(0)}38%{transform:translateX(-2px)}70%{transform:translateX(1px)}}
.setup-surface{width:100%;height:100%;min-height:0;display:flex;flex-direction:column;padding:24px 28px 18px;border:1px solid rgba(219,224,222,.14);border-radius:10px;background:#17191a;box-shadow:0 20px 56px rgba(0,0,0,.38);color:#eeede8}.setup-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:15px;border-bottom:1px solid #2c3030}.product-label{display:none}.setup-header h1{margin:0;color:#f3f1eb;font:620 21px/27px var(--ui);letter-spacing:-.35px}.window-controls{display:flex;align-items:center;padding-top:0}.window-button{width:28px;height:28px;border-radius:5px;color:#8e9694;font:18px/18px var(--ui)}.window-button:hover{background:#252828;color:#f0efea}
.connection-line{display:flex;align-items:center;gap:9px;min-height:32px;margin:11px 0 0;padding:0;border:0;color:#929b99;font:12px/16px var(--ui);overflow:hidden}.connection-state{position:relative;flex:0 0 auto;padding-left:13px;color:#b9a277;font:600 11px/16px var(--ui);letter-spacing:0}.connection-state::before{position:absolute;left:0;top:5px;width:6px;height:6px;border-radius:50%;background:#a88755;box-shadow:0 0 0 3px rgba(168,135,85,.09);content:""}.connection-state[data-connected="true"]{color:#9fc5ae}.connection-state[data-connected="true"]::before{background:#74a889;box-shadow:0 0 0 3px rgba(116,168,137,.1)}#connection-host{min-width:0;overflow:hidden;color:#7e8785;text-overflow:ellipsis;white-space:nowrap;font:11px/16px var(--mono)}
.setup-intro{margin:5px 0 18px;color:#a4aaa7;font:12px/17px var(--ui)}.defaults-panel,.pairing-panel{padding:0;border:0}.section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.section-heading p,.empty-kicker{margin:0;color:#deded8;font:600 12px/16px var(--ui);letter-spacing:0}.section-heading span{color:#737c79;font:10px/14px var(--ui);letter-spacing:0}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px 12px}.field{display:grid;gap:6px;color:#c5c9c6;font:550 11px/15px var(--ui)}.field span{color:#b8beb9}.field select,.field input{width:100%;min-width:0;height:36px;padding:0 10px;border:1px solid #3b4140;border-radius:6px;background:#101213;color:#eeede8;font:12px var(--ui);outline:0;transition:border-color 120ms ease,background-color 120ms ease}.field select:hover,.field input:hover{border-color:#515a58}.field select:focus,.field input:focus{border-color:#799c99;background:#121516}.field select:disabled{color:#717977}.field input::placeholder{color:#626b69}.field input[aria-invalid="true"]{border-color:#a96761}#effort-field{grid-column:1/-1}.selection-summary{min-height:17px;margin:10px 0 0;color:#8d9693;font:11px/16px var(--ui)}.defaults-actions{display:flex;align-items:center;gap:9px;margin-top:13px}.primary-button,.secondary-button{height:33px;border-radius:6px;cursor:pointer;font:600 12px var(--ui)}.primary-button{padding:0 14px;border:1px solid #789d99;background:#789d99;color:#101414}.primary-button:hover:not(:disabled){border-color:#8aaca8;background:#8aaca8}.primary-button:disabled{cursor:wait;opacity:.5}.secondary-button{padding:0 12px;border:1px solid #434a48;background:#222625;color:#deded9}.secondary-button:hover{border-color:#59615f;background:#292e2d}.link-button,.tray-button{appearance:none;border:0;background:transparent;color:#929b98;cursor:pointer;font:11px var(--ui)}.link-button{margin-left:auto;padding:7px 0}.link-button:hover,.tray-button:hover{color:#ecebe5}
.empty-provider{margin:auto 0;padding:20px 0;border-top:1px solid #2c3030;border-bottom:1px solid #2c3030}.empty-provider h2{margin:6px 0;color:#eeece7;font:620 17px/22px var(--ui);letter-spacing:-.2px}.empty-provider p:not(.empty-kicker){max-width:420px;margin:0 0 14px;color:#9ba39f;font:12px/17px var(--ui)}.pairing-panel{padding-top:2px}.pairing-panel form{display:grid;gap:9px}.helper{margin:0;color:#7f8885;font:11px/15px var(--ui)}.helper code{color:#b8bfbc;font:11px var(--mono)}.pairing-panel .primary-button{justify-self:start}.setup-message{min-height:38px;margin:14px 0 0;padding:8px 0 0 10px;border-left:2px solid #414947;color:#929b98;font:11px/15px var(--ui);overflow-wrap:anywhere}.setup-message[data-kind="progress"]{border-color:#688b88;color:#a8c0bd}.setup-message[data-kind="success"]{border-color:#6f9c80;color:#a9c5b3}.setup-message[data-kind="error"]{border-color:#a56560;color:#d8aaa5}.setup-surface footer{display:flex;align-items:center;margin-top:auto;padding-top:12px;border-top:1px solid #282c2b}.setup-surface footer>span,.setup-surface footer>i{display:none}.tray-button{margin-left:auto;padding:4px 0;font-size:11px;letter-spacing:0}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #88aaa7;outline-offset:2px}
@media (prefers-reduced-motion:reduce){.presence-orb,.presence-halo,.orb-current,.orb-caustic{animation:none!important}.field select,.field input{transition:none}}
</style>`;
  const presentationRepairScript =
    nextSurface === "setup"
      ? `<script>(()=>{document.getElementById('setup-title').textContent='Jarvis Companion';document.getElementById('defaults-heading').textContent='Agent defaults';document.getElementById('pairing-title').textContent='Connect this PC';document.querySelector('.setup-intro').textContent='Choose the agent used for spoken tasks. Project names can be said naturally in your request.';document.getElementById('minimize-footer').textContent='Keep running in the tray'})()</script>`
      : "";
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title><style>
:root{color-scheme:dark;--paper:#151719;--ground:#0d0f11;--line:#353a40;--line-quiet:#252a2f;--ink:#f1eee7;--muted:#a7adb4;--dim:#747c85;--blue:#7096b5;--blue-bright:#8cb5d5;--ochre:#b89a63;--brick:#bd7771;--green:#80ad94;--mono:"Cascadia Mono","SFMono-Regular",Consolas,monospace;--ui:"Segoe UI Variable","Segoe UI",system-ui,sans-serif}*{box-sizing:border-box}html,body,#surface-root{width:100%;height:100%}body{margin:0;background:transparent;color:var(--ink);font:13px var(--ui);overflow:hidden}#surface-root{overflow:hidden}button,input,select{font:inherit}.telemetry{width:100%;height:100%;display:grid;grid-template-columns:88px minmax(0,1fr) 116px;align-items:stretch;border:1px solid var(--line);border-radius:5px;background:var(--paper);overflow:hidden}.state-rail{display:flex;align-items:center;gap:8px;padding:0 13px;border-right:1px solid var(--line);color:var(--muted);font:700 10px var(--mono);letter-spacing:.52px}.indicator{display:block;width:7px;height:7px;background:#69717a;transition:background .15s ease}.telemetry-copy{min-width:0;align-self:center;padding:0 16px}.telemetry-copy p{margin:0}.telemetry-copy #state{color:var(--ink);font-size:13px;font-weight:650;letter-spacing:-.12px;line-height:18px}.telemetry-copy #detail{display:-webkit-box;max-height:30px;overflow:hidden;color:var(--muted);font-size:12px;line-height:15px;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}body[data-state="review"] .telemetry-copy{align-self:start;padding-top:17px;padding-bottom:17px}body[data-state="review"] .telemetry-copy #detail{max-height:210px;-webkit-line-clamp:14}.hotkey-hint{display:flex;flex-direction:column;justify-content:center;align-items:flex-end;gap:5px;padding:0 14px;border-left:1px solid var(--line);color:var(--dim)}.hotkey-hint span{font:700 9px var(--mono);letter-spacing:.45px;text-align:right}.hotkey-hint kbd{color:var(--muted);font:10px var(--mono);white-space:nowrap}body[data-state="listening"] .indicator,body[data-state="capturing"] .indicator{background:var(--blue-bright)}body[data-state="review"] .indicator,body[data-state="checking"] .indicator,body[data-state="routing"] .indicator{background:var(--ochre)}body[data-state="started"] .indicator{background:var(--green)}body[data-state="error"] .indicator{background:var(--brick)}body[data-state="error"] .telemetry-copy #state{color:#f0bbb6}.setup-surface{width:100%;height:100%;min-height:0;padding:17px 24px 12px;border:1px solid var(--line);border-radius:5px;background:var(--paper);display:flex;flex-direction:column}.setup-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.product-label,.section-heading p,.empty-kicker{margin:0;color:var(--blue-bright);font:700 10px var(--mono);letter-spacing:1px;line-height:14px}.setup-header h1{margin:3px 0 0;color:var(--ink);font-size:24px;font-weight:620;letter-spacing:-.5px;line-height:27px}.window-controls{display:flex;align-items:center;gap:9px;padding-top:1px}.window-button,.link-button,.tray-button{appearance:none;border:0;background:transparent;color:var(--muted);cursor:pointer}.window-button{width:24px;height:24px;color:var(--dim);font:16px/18px var(--ui)}.window-button:hover,.link-button:hover,.tray-button:hover{color:var(--ink)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--blue-bright);outline-offset:2px}.connection-line{display:flex;align-items:center;gap:9px;min-height:26px;margin-top:10px;padding:5px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;overflow:hidden}.connection-state{flex:0 0 auto;color:var(--ochre);font:700 9px var(--mono);letter-spacing:.5px}.connection-state[data-connected="true"]{color:var(--green)}#connection-host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.setup-intro{margin:8px 0 10px;color:var(--muted);font-size:12px;line-height:16px}.defaults-panel,.pairing-panel{border-top:1px solid var(--line-quiet);border-bottom:1px solid var(--line-quiet);padding:9px 0}.section-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}.section-heading span{color:var(--dim);font:9px var(--mono);letter-spacing:.42px}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px}.field{display:grid;gap:4px;color:#d7d8d5;font-size:11px;font-weight:600}.field span{color:#d1d4d8}.field select,.field input{width:100%;min-width:0;height:32px;border:1px solid #3c4249;border-radius:4px;background:var(--ground);color:var(--ink);padding:0 9px;font-size:12px;outline:none}.field select:disabled{color:#7f858c}.field input::placeholder{color:#687078}.field input[aria-invalid="true"]{border-color:var(--brick)}#effort-field{grid-column:1/-1}.selection-summary{min-height:16px;margin:8px 0 0;color:var(--muted);font-size:11px;line-height:16px}.defaults-actions{display:flex;align-items:center;gap:9px;margin-top:10px}.primary-button,.secondary-button{height:30px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:650}.primary-button{border:1px solid var(--blue-bright);background:var(--blue);color:#0d1114;padding:0 13px}.primary-button:hover:not(:disabled){background:var(--blue-bright)}.primary-button:disabled{cursor:wait;opacity:.58}.secondary-button{border:1px solid #505861;background:#20242a;color:#e4e4df;padding:0 11px}.secondary-button:hover{border-color:#78818b;background:#262c32}.link-button{margin-left:auto;padding:5px 0;font-size:11px}.empty-provider{margin:auto 0;padding:18px 0;border-top:1px solid var(--line-quiet);border-bottom:1px solid var(--line-quiet)}.empty-provider h2{margin:7px 0 5px;color:var(--ink);font-size:17px;font-weight:620;letter-spacing:-.2px}.empty-provider p:not(.empty-kicker){max-width:420px;margin:0 0 13px;color:var(--muted);font-size:12px;line-height:17px}.pairing-panel form{display:grid;gap:8px}.helper{margin:0;color:var(--dim);font-size:11px;line-height:15px}.helper code{color:#d4d8dd;font:11px var(--mono)}.pairing-panel .primary-button{justify-self:start}.setup-message{min-height:31px;margin:9px 0 0;padding:5px 0 0 9px;border-left:2px solid #48525d;color:var(--muted);font-size:11px;line-height:14px;overflow-wrap:anywhere}.setup-message[data-kind="progress"]{border-color:var(--blue);color:#b8cce0}.setup-message[data-kind="success"]{border-color:var(--green);color:#bbd4c4}.setup-message[data-kind="error"]{border-color:var(--brick);color:#e5afab}.setup-surface footer{display:flex;align-items:center;gap:6px;margin-top:auto;padding-top:9px;color:var(--dim);font:9px var(--mono);letter-spacing:.32px}.setup-surface footer i{font-style:normal;color:#525a63}.tray-button{margin-left:auto;padding:2px 0;color:#9ca4ac;font:9px var(--mono);letter-spacing:.32px}
</style>${voiceSurfaceStyle}${voiceSurfaceRefinementStyle}${voiceReviewStyle}${voiceCinematicStyle}${presentationRepairStyle}</head><body><div id="surface-root">${content}</div><script>${script}${voiceReviewScript}</script>${conversationModeScript}${presentationRepairScript}</body></html>`)}`;
}

function placeVoiceOverlay(status?: CompanionVoiceStatus) {
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
  voiceStatus?: CompanionVoiceStatus,
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

function scheduleBubbleHide(delay: number | undefined) {
  hideBubbleAbort?.abort();
  if (delay === undefined) return;
  const controller = new AbortController();
  hideBubbleAbort = controller;
  void Timers.setTimeout(delay, undefined, { signal: controller.signal })
    .then(() => {
      if (hideBubbleAbort === controller) bubbleWindow?.hide();
    })
    .catch(() => undefined);
}

function showCompanionStatus(status: CompanionVoiceStatus) {
  latestBubbleStatus = status;
  void loadSurface("voice", false, status).then(() => {
    bubbleWindow?.showInactive();
    flushVoiceOverlay();
  });
  scheduleBubbleHide(voiceOverlayAutoHideDelay(status));
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

function projectChoicePrompt(projects: ReadonlyArray<CompanionProjectTarget>): string {
  const names = projects.slice(0, 4).map((project) => project.title);
  const choices =
    names.length <= 1
      ? (names[0] ?? "the project you want")
      : `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
  return `Which project should I use? Say ${choices}.`;
}

async function resolveProjectForTranscript(input: {
  readonly host: string;
  readonly transcript: string;
  readonly projects?: ReadonlyArray<CompanionProjectTarget>;
  readonly taskTranscript?: string;
}): Promise<CompanionProjectTarget | undefined> {
  const catalog =
    input.projects === undefined
      ? await getCompanionProjectCatalog({ fetch: hostFetch, host: input.host })
      : { kind: "ready" as const, projects: input.projects };
  if (catalog.kind === "error") {
    showCompanionStatus({
      state: "I couldn't read your workspaces",
      detail: catalog.message,
      kind: "error",
    });
    void speakNativeSpeech(
      "I couldn't read the projects on Jarvis Host. Please try once more.",
    ).catch(() => undefined);
    if (catalog.needsPairing) openCompanionSetup();
    return undefined;
  }

  rememberProjectTargets(catalog.projects);
  const resolution = resolveCompanionProjectTarget({
    transcript: input.transcript,
    projects: catalog.projects,
    ...(input.projects === undefined && loadSavedProject() !== undefined
      ? { recentProjectId: loadSavedProject()!.id }
      : {}),
  });
  if (resolution.kind === "resolved") return resolution.project;
  if (resolution.kind === "no-projects") {
    const message = "Open or create a project on Jarvis Host, then try that again.";
    showCompanionStatus({
      state: "There isn't a project to use yet",
      detail: message,
      kind: "attention",
    });
    void speakNativeSpeech(message).catch(() => undefined);
    return undefined;
  }

  pendingProjectTask = {
    transcript: input.taskTranscript ?? input.transcript,
    projects: resolution.projects,
  };
  const prompt = projectChoicePrompt(resolution.projects);
  showCompanionStatus({
    state: "Which project?",
    detail: prompt,
    kind: "attention",
  });
  void speakNativeSpeech(prompt).catch(() => undefined);
  return undefined;
}

async function submitTranscriptToHost(
  transcript: string,
  voiceDefault = requireVoiceDefault(),
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  let taskTranscript = transcript.trim();
  if (taskTranscript.length === 0) {
    return { ok: false, message: "No task was heard." };
  }
  if (voiceDefault === undefined) {
    return {
      ok: false,
      message: "Choose voice defaults before sending a task.",
    };
  }

  let selectedProject: CompanionProjectTarget | undefined;
  const pending = pendingProjectTask;
  if (pending !== undefined) {
    if (/^(?:cancel|never mind|nevermind|stop)$/iu.test(taskTranscript)) {
      pendingProjectTask = undefined;
      showCompanionStatus({
        state: "Cancelled",
        detail: "That task wasn't started.",
        kind: "completed",
      });
      return { ok: true };
    }
    selectedProject = await resolveProjectForTranscript({
      host: voiceDefault.host,
      transcript: taskTranscript,
      projects: pending.projects,
      taskTranscript: pending.transcript,
    });
    if (selectedProject === undefined) return { ok: true };
    taskTranscript = pending.transcript;
    pendingProjectTask = undefined;
  }

  const explicitlyStartsNewTask = explicitlyStartsNewCompanionTask(taskTranscript);
  const continuationTarget = companionContinuationTarget({
    conversationMode: voiceDefault.conversationMode,
    transcript: taskTranscript,
    ...(attentionTarget === undefined ? {} : { attentionTarget }),
  });
  if (
    voiceDefault.conversationMode === "continue-last-thread" &&
    continuationTarget === undefined &&
    !explicitlyStartsNewTask &&
    attentionTarget === undefined
  ) {
    const message =
      "I don't have an exact task to continue yet. Open the task in T3, then wait for its next report or switch Voice defaults to start a new thread.";
    showCompanionStatus({
      state: "Choose the task to continue",
      detail: message,
      kind: "attention",
    });
    void speakNativeSpeech(
      "I need the exact task before I can continue safely. Open it in T3, or switch me to a new thread.",
    ).catch(() => undefined);
    return { ok: false, message };
  }

  if (
    continuationTarget === undefined &&
    selectedProject === undefined &&
    !companionTranscriptHasProjectCue(taskTranscript) &&
    attentionTarget !== undefined
  ) {
    selectedProject = await resolveProjectTargetById(attentionTarget.projectId);
  }
  if (continuationTarget === undefined && selectedProject === undefined) {
    selectedProject = await resolveProjectForTranscript({
      host: voiceDefault.host,
      transcript: taskTranscript,
    });
    if (selectedProject === undefined) return { ok: true };
  }

  const continuationContext =
    continuationTarget === undefined
      ? undefined
      : await resolveProjectContext(continuationTarget.projectId);
  const targetContext =
    continuationTarget === undefined
      ? projectTargetContext(selectedProject!)
      : (continuationContext ?? "Existing task · project details unavailable");
  showCompanionStatus({
    state: "Routing this safely",
    detail:
      continuationTarget === undefined
        ? `Starting a new task in ${selectedProject!.title}.`
        : "Returning to the exact conversation that asked for you.",
    kind: "routing",
    context: targetContext,
  });
  const result = await submitCompanionTask({
    fetch: hostFetch,
    host: voiceDefault.host,
    utterance: taskTranscript,
    ...(continuationTarget === undefined
      ? explicitlyStartsNewTask
        ? {}
        : { modelSelection: voiceDefault.modelSelection }
      : {
          projectId: continuationTarget.projectId,
          contextThreadId: continuationTarget.threadId,
          continueContext: true,
        }),
    ...(attentionTarget === undefined ? {} : { referenceThreadId: attentionTarget.threadId }),
    projectId: continuationTarget?.projectId ?? selectedProject!.id,
  });
  if (result.kind === "started") {
    if (!reportRelayAvailable) connectReportRelay(voiceDefault.host);
    rememberAttentionTarget({ projectId: result.projectId, threadId: result.threadId });
    if (continuationTarget === undefined) saveProject(selectedProject!);
    showCompanionStatus({
      state: continuationTarget === undefined ? "I’ve started the task" : "I’ve continued the task",
      detail: result.objective,
      kind: "started",
      context: targetContext,
    });
    void speakNativeSpeech(
      continuationTarget === undefined
        ? `Got it. I'll work in ${selectedProject!.title} and let you know when there's something useful.`
        : "I've picked that back up. I'll let you know when there's something useful.",
    ).catch(() => undefined);
    return { ok: true };
  }
  if (result.kind === "acknowledged") {
    if (result.threadId !== undefined) {
      rememberAttentionTarget({ projectId: result.projectId, threadId: result.threadId });
    }
    if (result.action === "focused" && selectedProject !== undefined) saveProject(selectedProject);
    showCompanionStatus({
      state:
        result.action === "queued"
          ? "Next step saved"
          : result.action === "steered"
            ? "Task updated"
            : result.action === "interrupted"
              ? "Task stopped"
              : result.action === "focused"
                ? "Project selected"
                : "Task status",
      detail: result.message,
      kind: "completed",
      context: targetContext,
    });
    void speakNativeSpeech(result.message).catch(() => undefined);
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
  if (result.reason === "project_not_found") {
    clearRememberedProject();
  }
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
  const providerCatalog = await getCompanionProviderCatalog({ fetch: hostFetch, host });
  if (providerCatalog.kind === "error") {
    return {
      ok: false,
      message: providerCatalog.message,
      needsPairing: providerCatalog.needsPairing,
    } as const;
  }
  return {
    ok: true,
    connected: true,
    host,
    providers: normalizeCompanionProviders(providerCatalog.providers),
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
  attentionTarget = loadCompanionSettings().attentionTarget;
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
    rememberAttentionTarget({
      projectId: target.projectId,
      threadId: target.threadId,
      ...("reportKind" in target &&
      ["completed", "waiting-for-input", "approval-needed", "failed"].includes(
        String(target.reportKind),
      )
        ? {
            reportKind: target.reportKind as
              | "completed"
              | "waiting-for-input"
              | "approval-needed"
              | "failed",
          }
        : {}),
    });
    return { accepted: true };
  });
  ipcMain.handle("jarvis-companion:task-status", async (event, status: unknown) => {
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
    const reportStatusId =
      "statusId" in status && typeof status.statusId === "string" ? status.statusId : undefined;
    if (reportStatusId !== undefined) latestRelayStatusId = reportStatusId;
    const reportTarget = attentionTarget;
    const reportProjectContext =
      reportTarget === undefined ? undefined : await resolveProjectContext(reportTarget.projectId);
    if (
      (reportStatusId !== undefined && latestRelayStatusId !== reportStatusId) ||
      reportTarget?.projectId !== attentionTarget?.projectId ||
      reportTarget?.threadId !== attentionTarget?.threadId
    ) {
      return;
    }
    showCompanionStatus({
      state: status.state,
      detail: status.detail,
      kind: status.kind,
      ...("context" in status && typeof status.context === "string"
        ? { context: status.context }
        : reportProjectContext === undefined
          ? {}
          : { context: reportProjectContext }),
      ...("stream" in status && typeof status.stream === "boolean"
        ? { stream: status.stream }
        : {}),
      ...("statusId" in status && typeof status.statusId === "string"
        ? { statusId: status.statusId }
        : {}),
    });
  });
  ipcMain.handle(SPEAK_CHANNEL, async (event, text: unknown) => {
    if (!isRelaySender(event)) return;
    if (typeof text !== "string" || text.trim().length === 0) return;
    await speakNativeSpeech(text.trim());
  });
  ipcMain.handle(FINISH_STATUS_CHANNEL, (event, statusId: unknown) => {
    if (
      !isRelaySender(event) ||
      typeof statusId !== "string" ||
      latestBubbleStatus?.kind !== "completed" ||
      latestBubbleStatus.statusId !== statusId
    ) {
      return { accepted: false };
    }
    scheduleBubbleHide(voiceOverlaySpeechGraceDelay);
    return { accepted: true };
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
