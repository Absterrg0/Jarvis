import type {
  DesktopJarvisLiveVoiceState,
  DesktopJarvisLiveVoiceStatus,
  DesktopJarvisOrbCatalog,
  DesktopJarvisOrbSelection,
} from "@t3tools/contracts";

/** Expanded window footprint: dot plus the provider and running-agent lists. */
export const DESKTOP_JARVIS_ORB_WINDOW_WIDTH = 384;
export const DESKTOP_JARVIS_ORB_WINDOW_HEIGHT = 440;
export const DESKTOP_JARVIS_ORB_MARGIN = 16;
/** Collapsed window footprint. Keep the native hit area close to the visible dot. */
export const DESKTOP_JARVIS_ORB_COLLAPSED_WIDTH = 48;
export const DESKTOP_JARVIS_ORB_COLLAPSED_HEIGHT = 48;

/** Console/stdout bridge prefix. Overlay JS logs selections; main parses them. */
export const DESKTOP_JARVIS_ORB_CONSOLE_PREFIX = "[jarvis-orb]";

export interface DesktopJarvisOrbPresentation {
  readonly label: string;
  readonly accent: string;
  readonly accentSecondary: string;
  readonly animated: boolean;
}

const DESKTOP_JARVIS_ORB_PROFILES: Readonly<
  Record<DesktopJarvisLiveVoiceStatus, { label: string; accent: string; accentSecondary: string }>
> = {
  idle: { label: "Jarvis is idle", accent: "#9d9c94", accentSecondary: "#9d9c94" },
  requesting: {
    label: "Starting live conversation",
    accent: "#d0c6a3",
    accentSecondary: "#d0c6a3",
  },
  connecting: {
    label: "Connecting live conversation",
    accent: "#d0c6a3",
    accentSecondary: "#d0c6a3",
  },
  live: { label: "Live conversation", accent: "#91ba79", accentSecondary: "#91ba79" },
  closing: { label: "Ending live conversation", accent: "#aaa89c", accentSecondary: "#aaa89c" },
  failed: { label: "Live conversation failed", accent: "#cf8b80", accentSecondary: "#cf8b80" },
};

/** State remains legible when motion is reduced; idle has no render loop. */
export const desktopJarvisOrbPresentation = (
  state: DesktopJarvisLiveVoiceState,
): DesktopJarvisOrbPresentation => {
  const profile = DESKTOP_JARVIS_ORB_PROFILES[state.status];
  const animated =
    state.active &&
    (state.status === "requesting" || state.status === "connecting" || state.status === "live");
  return { ...profile, animated };
};

const serializedOrbProfiles = JSON.stringify(DESKTOP_JARVIS_ORB_PROFILES).replaceAll(
  "<",
  "\\u003c",
);

export interface DesktopJarvisOverlayWorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopJarvisOverlayBounds extends DesktopJarvisOverlayWorkArea {}

export function resolveDesktopJarvisOverlayBounds(
  workArea: DesktopJarvisOverlayWorkArea,
  expanded: boolean,
): DesktopJarvisOverlayBounds {
  const width = Math.min(
    expanded ? DESKTOP_JARVIS_ORB_WINDOW_WIDTH : DESKTOP_JARVIS_ORB_COLLAPSED_WIDTH,
    Math.max(48, workArea.width - DESKTOP_JARVIS_ORB_MARGIN * 2),
  );
  const height = Math.min(
    expanded ? DESKTOP_JARVIS_ORB_WINDOW_HEIGHT : DESKTOP_JARVIS_ORB_COLLAPSED_HEIGHT,
    Math.max(48, workArea.height - DESKTOP_JARVIS_ORB_MARGIN * 2),
  );
  return {
    x: Math.round(workArea.x + workArea.width - width - DESKTOP_JARVIS_ORB_MARGIN),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

const orbScript = String.raw`<script>
(() => {
  const main = document.querySelector("[data-orb-root]");
  const orb = document.querySelector("[data-orb]");
  const picker = document.querySelector("[data-picker]");
  const list = document.querySelector("[data-provider-list]");
  const runningSection = document.querySelector("[data-running-section]");
  const runningList = document.querySelector("[data-running-list]");
  const errorRow = document.querySelector("[data-picker-error]");
  const prefix = ${JSON.stringify(DESKTOP_JARVIS_ORB_CONSOLE_PREFIX)};
  if (!main || !orb || !picker || !list || !runningSection || !runningList || !errorRow) return;

  const profiles = ${serializedOrbProfiles};
  let liveState = { enabled: false, active: false, status: "idle" };
  let catalog = { providers: [], selected: null, pendingSelection: null, error: null };
  let expanded = false;

  const setExpanded = (next) => {
    if (expanded === next) return;
    expanded = next;
    picker.hidden = !expanded;
    main.dataset.expanded = expanded ? "true" : "false";
    orb.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (!expanded) orb.focus({ preventScroll: true });
    console.log(prefix + " " + JSON.stringify({ type: "expanded", expanded }));
  };

  const selectionKey = (selection) =>
    selection === null || selection === undefined
      ? ""
      : selection.instanceId + "\u0000" + selection.model;

  const renderStatus = () => {
    const profile = profiles[liveState.status] ?? profiles.idle;
    const animated =
      liveState.active &&
      (liveState.status === "requesting" ||
        liveState.status === "connecting" ||
        liveState.status === "live");
    main.dataset.live = liveState.status;
    main.dataset.active = liveState.active ? "true" : "false";
    main.style.setProperty("--accent", profile.accent);
    main.style.setProperty("--accent-secondary", profile.accentSecondary);
    const level = typeof liveState.level === "number" && isFinite(liveState.level)
      ? Math.max(0, Math.min(1, liveState.level))
      : 0;
    main.style.setProperty("--level", String(level));
    orb.dataset.live = liveState.status;
    const workingCount = Array.isArray(catalog.agents) ? catalog.agents.filter(agent => agent.status !== "offline").length : 0;
    const label = liveState.status === "idle" && workingCount > 0
      ? workingCount + (workingCount === 1 ? " agent active" : " agents active")
      : profile.label;
    document.querySelector("[data-live-label]").textContent = label;
    orb.classList.toggle("is-live", animated);
    orb.title = label;
    orb.setAttribute("aria-label", label + ". Activate to choose providers and running agents.");
  };

  const clearList = () => {
    while (list.firstChild) list.removeChild(list.firstChild);
  };

  const CHECK_SVG =
    '<svg class="row-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 5"/></svg>';
  const makeCheck = () => {
    const slot = document.createElement("span");
    slot.innerHTML = CHECK_SVG;
    return slot.firstChild;
  };

  const renderPicker = () => {
    clearList();
    runningList.textContent = "";
    const selectedKey = selectionKey(catalog.selected);
    const pendingKey = selectionKey(catalog.pendingSelection);
    const busy = catalog.pendingSelection !== null && catalog.pendingSelection !== undefined;
    const providers = Array.isArray(catalog.providers) ? catalog.providers.slice(0, 6) : [];
    if (providers.length === 0) {
      const empty = document.createElement("p");
      empty.className = "picker-empty";
      empty.textContent = "No providers advertised.";
      list.appendChild(empty);
    }
    for (const provider of providers) {
      const model = (provider.models ?? [])[0];
      if (!model) continue;
        const key = provider.instanceId + "\u0000" + model.slug;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "provider-row";
        row.disabled = busy || provider.available === false;
        row.dataset.selected = key === selectedKey ? "true" : "false";
        row.dataset.available = provider.available === false ? "false" : "true";
        const providerName = provider.displayName ?? provider.instanceId;
        const modelName = model.name ?? model.slug;
        const isSelected = key === selectedKey;
        const isPending = key === pendingKey;
        const isUnavailable = provider.available === false;
        row.setAttribute(
          "aria-label",
          providerName + " with " + modelName +
            (isPending ? ", saving" : isSelected ? ", current" : isUnavailable ? ", unavailable" : ""),
        );
        const text = document.createElement("span");
        text.className = "row-text";
        const providerSpan = document.createElement("span");
        providerSpan.className = "row-provider";
        providerSpan.textContent = providerName;
        text.appendChild(providerSpan);
        const modelSpan = document.createElement("span");
        modelSpan.className = "row-model";
        modelSpan.textContent = modelName;
        text.appendChild(modelSpan);
        row.appendChild(text);
        const state = document.createElement("span");
        state.className = "row-state";
        if (isPending) state.textContent = "Saving…";
        else if (isSelected) state.appendChild(makeCheck());
        else if (isUnavailable) state.textContent = "Unavailable";
        row.appendChild(state);
        row.addEventListener("click", () => {
          if (row.disabled) return;
          console.log(prefix + " " + JSON.stringify({ type: "select", instanceId: provider.instanceId, model: model.slug }));
        });
        list.appendChild(row);
    }
    const runningAgents = Array.isArray(catalog.agents)
      ? catalog.agents.filter((agent) => agent && typeof agent.title === "string")
      : [];
    main.dataset.hasWork = runningAgents.some((agent) => agent.status !== "offline") ? "true" : "false";
    renderStatus();
    runningSection.hidden = false;
    document.querySelector(".running-label").textContent = "Running agents · " + runningAgents.length;
    if (!runningAgents.length) {
      const empty = document.createElement("p"); empty.className = "picker-empty";
      empty.textContent = "No agents running"; runningList.appendChild(empty);
    }
    for (const agent of runningAgents) {
      const row = document.createElement("div");
      row.className = "agent-row";
      row.dataset.status = agent.status;
      const marker = document.createElement("span");
      marker.className = "agent-marker";
      marker.setAttribute("aria-hidden", "true");
      row.appendChild(marker);
      const text = document.createElement("span");
      text.className = "agent-text";
      text.textContent = agent.title;
      text.title = agent.title;
      const detail = document.createElement("small");
      detail.textContent = [agent.providerLabel, agent.nodeLabel, agent.projectTitle].filter(Boolean).join(" · ");
      text.appendChild(detail);
      row.appendChild(text);
      if (typeof agent.status === "string" && agent.status.length > 0) {
        const status = document.createElement("span");
        status.className = "agent-status";
        status.textContent = agent.status;
        row.appendChild(status);
      }
      runningList.appendChild(row);
    }
    if (typeof catalog.error === "string" && catalog.error.length > 0) {
      errorRow.hidden = false;
      errorRow.textContent = catalog.error;
    } else {
      errorRow.hidden = true;
      errorRow.textContent = "";
    }
  };

  orb.addEventListener("click", () => setExpanded(!expanded));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && expanded) setExpanded(false);
    if (event.key === "Tab") {
      const controls = expanded ? [orb, ...picker.querySelectorAll("button:not(:disabled)")] : [orb];
      const index = controls.indexOf(document.activeElement);
      event.preventDefault();
      controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length].focus();
    }
  });

  window.__jarvisOrb = {
    setLiveState: (next) => {
      if (next === null || typeof next !== "object") return;
      liveState = next;
      renderStatus();
    },
    setCatalog: (next) => {
      if (next === null || typeof next !== "object") return;
      catalog = next;
      renderPicker();
    },
  };
  renderStatus();
  renderPicker();
})();
</script>`;

/** Local activity panel. Updates come from the host; idle renders no frames. */
export function desktopJarvisOverlayDataUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';connect-src 'none';img-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
body{color:#f3f1ed;font:400 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}main{position:absolute;inset:0;--accent:#9d9c94}
.orb-wrap{position:absolute;right:0;top:calc(50% - 24px);width:48px;height:48px;display:grid;place-items:center}
.orb{position:relative;width:28px;height:40px;border:1px solid #4a4940;border-radius:18px;cursor:pointer;background:#171713;outline:none;display:grid;place-items:center}
.orb:before{content:"";width:9px;height:9px;border-radius:50%;background:var(--accent)}
.orb:hover{background:#2b2b25}.orb:focus-visible{outline:2px solid #e6e2d7;outline-offset:2px}
main[data-has-work="true"][data-live="idle"] .orb:before{background:#91ba79}
main[data-live="live"] .orb:before{box-shadow:0 0 0 3px #91ba7926}
main[data-active="true"][data-live="requesting"] .orb:before,main[data-active="true"][data-live="connecting"] .orb:before{animation:status-enter .8s ease-in-out 2}
@keyframes status-enter{50%{opacity:.35}}
.picker{position:absolute;left:0;top:0;bottom:0;width:calc(100% - 58px);padding:18px 12px;overflow:auto;scrollbar-width:thin;scrollbar-color:#44443d transparent;border:1px solid #3c3c35;border-radius:13px;background:#151512;color:#f3f1ed}
.picker[hidden]{display:none}.picker-brand{display:flex;justify-content:space-between;align-items:center;margin:0 6px 4px;font-size:15px;font-weight:600;letter-spacing:-.02em}.picker-brand span{color:#aaa89f;font-size:11px;font-weight:400;letter-spacing:0}
.live-label{margin:0 6px 22px;color:#aaa89f;font-size:11px}.picker-label,.running-label{margin:0 6px 8px;color:#aaa89f;font-size:12px;font-weight:500}
.picker-list,.running-list{display:flex;flex-direction:column;gap:3px}
.provider-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:47px;width:100%;padding:8px 10px;text-align:left;color:#f3f1ed;background:transparent;border:1px solid transparent;border-radius:7px;cursor:pointer}
.provider-row:hover:not(:disabled),.provider-row[data-selected="true"]{background:#292922}.provider-row:disabled{cursor:default;opacity:.5}.provider-row:focus-visible{outline:2px solid #aaa89f;outline-offset:-2px}.row-text{display:grid;gap:2px;min-width:0}.row-provider{font-size:12px;font-weight:500}.row-model{font-size:11px;color:#aaa89f}.row-state{font-size:10px;color:#c9c7bc}.row-check{width:14px;height:14px;fill:none;stroke:#c9c7bc;stroke-width:1.5}.picker-empty{margin:0;padding:8px 6px;color:#aaa89f;font-size:12px}.picker-error{padding:8px;color:#cf8b80;font-size:11px}.picker-error[hidden]{display:none}.picker-hint{margin:20px 6px 0;color:#8d8c82;font-size:10px}
.running-section{margin-top:18px;padding-top:18px;border-top:1px solid #34342d}.agent-row{display:flex;align-items:center;gap:8px;padding:9px 6px}.agent-marker{width:5px;height:5px;flex:none;border-radius:50%;background:#91ba79}.agent-row[data-status="offline"] .agent-marker{background:#8d8c82}.agent-row[data-status="waiting"] .agent-marker{background:#c9ad73}.agent-text{min-width:0;flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agent-text small{display:block;color:#aaa89f;font-size:10px;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.agent-status{font-size:10px;color:#aaa89f;text-transform:capitalize}
@media(prefers-reduced-motion: reduce){.orb:before{animation:none!important}}
</style></head><body><main data-orb-root data-live="idle" data-expanded="false"><div class="orb-wrap"><button class="orb" data-orb aria-expanded="false" aria-label="Jarvis. Activate to choose providers and running agents."></button></div><section class="picker" aria-label="Jarvis activity" data-picker hidden><div class="picker-brand">Jarvis<span>Activity</span></div><p class="live-label" data-live-label></p><p class="picker-label">Providers</p><div class="picker-list" data-provider-list></div><section class="running-section" data-running-section hidden><p class="running-label">Running agents</p><div class="running-list" data-running-list></div></section><p class="picker-error" data-picker-error hidden></p><p class="picker-hint">Ctrl+Shift+J toggles voice.</p></section></main>${orbScript}</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function desktopJarvisOrbStateScript(state: DesktopJarvisLiveVoiceState): string {
  return `window.__jarvisOrb?.setLiveState(${JSON.stringify(state)})`;
}

export function desktopJarvisOrbCatalogScript(catalog: DesktopJarvisOrbCatalog): string {
  return `window.__jarvisOrb?.setCatalog(${JSON.stringify(catalog)})`;
}

export interface DesktopJarvisOrbExpansionEvent {
  readonly type: "expanded";
  readonly expanded: boolean;
}

/** Parse the overlay's bounded expansion event separately from provider picks. */
export function parseDesktopJarvisOverlayEvent(
  line: string,
): DesktopJarvisOrbSelection | DesktopJarvisOrbExpansionEvent | null {
  const prefix = line.startsWith(DESKTOP_JARVIS_ORB_CONSOLE_PREFIX)
    ? DESKTOP_JARVIS_ORB_CONSOLE_PREFIX
    : null;
  if (prefix === null) return null;
  const payload = line.slice(prefix.length).trim();
  try {
    const value = JSON.parse(payload) as Partial<DesktopJarvisOrbEventLike> & {
      readonly expanded?: unknown;
    };
    if (value.type === "expanded" && typeof value.expanded === "boolean") {
      return { type: "expanded", expanded: value.expanded };
    }
  } catch {
    return null;
  }
  return parseDesktopJarvisOrbEvent(line);
}

/** Parse one console/stdout line from the orb document into a selection. */
export function parseDesktopJarvisOrbEvent(line: string): DesktopJarvisOrbSelection | null {
  const prefix = line.startsWith(DESKTOP_JARVIS_ORB_CONSOLE_PREFIX)
    ? DESKTOP_JARVIS_ORB_CONSOLE_PREFIX
    : null;
  if (prefix === null) return null;
  const payload = line.slice(prefix.length).trim();
  try {
    const value = JSON.parse(payload) as Partial<DesktopJarvisOrbEventLike>;
    if (value.type !== "select") return null;
    if (typeof value.instanceId !== "string" || value.instanceId.length === 0) return null;
    if (typeof value.model !== "string" || value.model.length === 0) return null;
    if (value.instanceId.length > 256 || value.model.length > 256) return null;
    return { instanceId: value.instanceId, model: value.model };
  } catch {
    return null;
  }
}

type DesktopJarvisOrbEventLike = {
  readonly type?: unknown;
  readonly instanceId?: unknown;
  readonly model?: unknown;
};
