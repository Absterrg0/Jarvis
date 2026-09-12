import type {
  DesktopJarvisLiveVoiceState,
  DesktopJarvisLiveVoiceStatus,
  DesktopJarvisOrbCatalog,
  DesktopJarvisOrbSelection,
} from "@t3tools/contracts";

/** Orb window footprint: orb plus the expanded shortlist picker. */
export const DESKTOP_JARVIS_ORB_WINDOW_WIDTH = 264;
export const DESKTOP_JARVIS_ORB_WINDOW_HEIGHT = 360;
export const DESKTOP_JARVIS_ORB_MARGIN = 16;

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
  idle: { label: "ARIS is idle", accent: "#8db5ae", accentSecondary: "#7388d7" },
  requesting: {
    label: "Starting live conversation",
    accent: "#8dd8cf",
    accentSecondary: "#6b9bf2",
  },
  connecting: {
    label: "Connecting live conversation",
    accent: "#71d6cd",
    accentSecondary: "#618df4",
  },
  live: { label: "Live conversation", accent: "#7fe3d4", accentSecondary: "#7aa2f7" },
  closing: { label: "Ending live conversation", accent: "#9ba9ff", accentSecondary: "#c18bed" },
  failed: { label: "Live conversation failed", accent: "#ff9c9c", accentSecondary: "#ec6e83" },
};

/**
 * Orb glow follows the real live session. A slow breathe and conic swirl run
 * continuously so the orb reads as fluid, with a stronger pulse while a
 * session is active (requesting/connecting/live). State stays legible through
 * color and glow alone when motion is reduced. Hover glow is CSS-only.
 */
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

const orbScript = String.raw`<script>
(() => {
  const main = document.querySelector("[data-orb-root]");
  const orb = document.querySelector("[data-orb]");
  const picker = document.querySelector("[data-picker]");
  const list = document.querySelector("[data-provider-list]");
  const errorRow = document.querySelector("[data-picker-error]");
  const prefix = ${JSON.stringify(DESKTOP_JARVIS_ORB_CONSOLE_PREFIX)};
  if (!main || !orb || !picker || !list || !errorRow) return;

  const profiles = ${serializedOrbProfiles};
  let liveState = { enabled: false, active: false, status: "idle" };
  let catalog = { providers: [], selected: null, pendingSelection: null, error: null };
  let expanded = false;

  const orbCanvas = document.querySelector("[data-orb-canvas]");
  let gl = null;
  let shaderUniforms = null;

  const hexToRgb = (hex) => {
    const value = String(hex || "#8db5ae").replace("#", "");
    const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
    const int = parseInt(full, 16);
    return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
  };

  const ORB_VERT = "attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }";
  const ORB_FRAG = [
    "precision highp float;",
    "uniform vec2 u_res;",
    "uniform float u_time;",
    "uniform float u_level;",
    "uniform float u_active;",
    "uniform vec3 u_accent;",
    "uniform vec3 u_accent2;",
    "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }",
    "float noise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f); return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),u.x), mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),u.x), u.y); }",
    "float fbm(vec2 p){ float s=0.0; float a=0.5; for(int i=0;i<5;i++){ s+=a*noise(p); p=p*2.03+vec2(11.3,7.7); a*=0.5; } return s; }",
    "void main(){",
    "  vec2 p = (2.0*vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) - u_res)/u_res.y;",
    "  float r = length(p);",
    "  float t = u_time*(0.14 + u_level*1.2 + u_active*0.4);",
    "  vec2 q = vec2(fbm(p*1.7 + t*0.35), fbm(p*1.7 + vec2(5.2,1.3) - t*0.3));",
    "  vec2 w = p + 0.9*q;",
    "  float n = fbm(w*2.1 + t);",
    "  float n2 = fbm(w*3.4 - t*0.55 + vec2(1.7,9.2));",
    "  float liquid = smoothstep(0.15,1.0, n*0.7 + n2*0.5);",
    "  vec3 col = mix(u_accent, u_accent2, clamp(q.x*0.6 + n2*0.35 + 0.4, 0.0, 1.0));",
    "  col = mix(col, vec3(1.0), pow(liquid, 4.0)*0.26);",
    "  float shade = smoothstep(1.05,0.1,r);",
    "  col *= 0.4 + 0.95*shade;",
    "  float rim = smoothstep(0.82,1.0,r)*smoothstep(1.03,0.98,r);",
    "  col += mix(u_accent, vec3(1.0), 0.25)*rim*(0.3 + u_level*1.0);",
    "  float spec = pow(max(0.0,1.0-length(p-vec2(-0.32,-0.38))*2.0), 3.0);",
    "  col += vec3(1.0)*spec*0.07;",
    "  float glow = smoothstep(1.08,0.35,r);",
    "  float alpha = smoothstep(1.0,0.9,r);",
    "  gl_FragColor = vec4(col*(0.9+u_level*0.45)*glow, alpha);",
    "}"
  ].join("\n");

  const initOrbShader = () => {
    if (!orbCanvas) return;
    try {
      gl = orbCanvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: true, depth: false, stencil: false });
      if (!gl) return;
      const compile = (type, source) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, source);
        gl.compileShader(sh);
        return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
      };
      const vs = compile(gl.VERTEX_SHADER, ORB_VERT);
      const fs = compile(gl.FRAGMENT_SHADER, ORB_FRAG);
      if (!vs || !fs) return;
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "a_pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      shaderUniforms = {
        res: gl.getUniformLocation(prog, "u_res"),
        time: gl.getUniformLocation(prog, "u_time"),
        level: gl.getUniformLocation(prog, "u_level"),
        active: gl.getUniformLocation(prog, "u_active"),
        accent: gl.getUniformLocation(prog, "u_accent"),
        accent2: gl.getUniformLocation(prog, "u_accent2")
      };
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      orbCanvas.width = Math.round(60*dpr);
      orbCanvas.height = Math.round(60*dpr);
      main.classList.add("webgl");
      const started = performance.now();
      const frame = () => {
        if (!gl || !shaderUniforms) return;
        const profile = profiles[liveState.status] || profiles.idle;
        const a = hexToRgb(profile.accent);
        const b = hexToRgb(profile.accentSecondary);
        const level = typeof liveState.level === "number" && isFinite(liveState.level)
          ? Math.max(0, Math.min(1, liveState.level)) : 0;
        gl.viewport(0, 0, orbCanvas.width, orbCanvas.height);
        gl.uniform2f(shaderUniforms.res, orbCanvas.width, orbCanvas.height);
        gl.uniform1f(shaderUniforms.time, (performance.now() - started) / 1000);
        gl.uniform1f(shaderUniforms.level, level);
        gl.uniform1f(shaderUniforms.active, liveState.active ? 1 : 0);
        gl.uniform3f(shaderUniforms.accent, a[0], a[1], a[2]);
        gl.uniform3f(shaderUniforms.accent2, b[0], b[1], b[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    } catch (error) {
      gl = null;
    }
  };
  initOrbShader();

  const setExpanded = (next) => {
    expanded = next;
    picker.hidden = !expanded;
    orb.setAttribute("aria-expanded", expanded ? "true" : "false");
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
    main.style.setProperty("--accent", profile.accent);
    main.style.setProperty("--accent-secondary", profile.accentSecondary);
    const level = typeof liveState.level === "number" && isFinite(liveState.level)
      ? Math.max(0, Math.min(1, liveState.level))
      : 0;
    main.style.setProperty("--level", String(level));
    orb.dataset.live = liveState.status;
    orb.classList.toggle("is-live", animated);
    orb.setAttribute(
      "aria-label",
      animated ? profile.label + ". Activate to choose provider." : "ARIS. Activate to choose provider.",
    );
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
        row.disabled = busy;
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

/**
 * The orb is a tiny local document. No framework, network, canvas, or render
 * loop: live-state and catalog updates patch CSS variables and attributes,
 * while compositor-friendly CSS keyframes handle the breathe and swirl. No
 * status sentence sits under the orb; state lives in the glow plus the
 * button aria-label, with the shortcut hint below the list inside the
 * picker. Clicks expand a short provider picker; selections leave as
 * console lines the host parses.
 */
export function desktopJarvisOverlayDataUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';connect-src 'none';img-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
body{color:#1d1a15;font:500 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{box-sizing:border-box;position:absolute;top:0;right:0;width:264px;max-height:360px;padding:12px 12px 12px 0;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.orb-wrap{position:relative;width:76px;height:76px;display:grid;place-items:center;background:transparent;border:0;padding:0}
.orb-halo{position:absolute;inset:-2px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--accent,#8db5ae) 62%,transparent),transparent 64%);opacity:.32;filter:blur(11px);transition:opacity 240ms ease}
.orb{position:relative;z-index:1;width:60px;height:60px;border-radius:50%;border:1px solid rgba(255,255,255,.2);cursor:pointer;overflow:hidden;background:radial-gradient(circle at 32% 26%,rgba(255,255,255,.9),rgba(255,255,255,0) 32%),radial-gradient(circle at 70% 74%,var(--accent-secondary,#7388d7),rgba(11,13,17,0) 60%),radial-gradient(circle at 50% 48%,var(--accent,#8db5ae),#0b0d11 80%);box-shadow:0 8px 24px rgba(0,0,0,.5),0 0 18px color-mix(in srgb,var(--accent,#8db5ae) 34%,transparent),inset 0 1px 2px rgba(255,255,255,.22),inset 0 -6px 14px rgba(0,0,0,.42);transition:box-shadow 200ms ease;animation:orb-breathe 5.2s ease-in-out infinite}
.orb::before{content:"";position:absolute;inset:-24%;border-radius:50%;background:conic-gradient(from 0deg,transparent 0 56%,color-mix(in srgb,var(--accent,#8db5ae) 66%,white) 76%,transparent 90%);opacity:.85;animation:orb-spin 11s linear infinite}
.orb::after{content:"";position:absolute;inset:8%;border-radius:50%;background:radial-gradient(circle at 35% 29%,rgba(255,255,255,.8),rgba(255,255,255,.06) 30%,transparent 52%),radial-gradient(circle at 50% 58%,color-mix(in srgb,var(--accent,#8db5ae) 52%,transparent),transparent 70%)}
main[data-live="live"] .orb{transform:scale(calc(1 + var(--level,0) * 0.16));transition:transform 80ms linear}
main[data-live="live"] .orb-halo{opacity:calc(.34 + var(--level,0) * .5)}
.orb:hover{box-shadow:0 10px 28px rgba(0,0,0,.52),0 0 30px color-mix(in srgb,var(--accent,#8db5ae) 54%,transparent),inset 0 1px 2px rgba(255,255,255,.26),inset 0 -6px 14px rgba(0,0,0,.42)}
.orb:focus-visible{outline:2px solid var(--accent,#8db5ae);outline-offset:3px}
.orb.is-live{animation-duration:2.1s}
.orb-canvas{position:absolute;width:60px;height:60px;border-radius:50%;z-index:0}
main.webgl .orb{background:transparent;border-color:transparent;box-shadow:none;animation:none}
main.webgl .orb::before,main.webgl .orb::after{display:none}
main.webgl .orb-halo{opacity:calc(.16 + var(--level,0) * .38)}
main.webgl .orb-ring{border-color:color-mix(in srgb,var(--accent,#8db5ae) 45%,transparent)}
.orb-ring{position:absolute;inset:5px;border-radius:50%;border:1.5px solid color-mix(in srgb,var(--accent,#8db5ae) 72%,transparent);opacity:0;transform:scale(.9);pointer-events:none}
main[data-live="requesting"] .orb-ring,main[data-live="connecting"] .orb-ring{opacity:.85;animation:orb-wake 1.5s ease-out infinite}
main[data-live="live"] .orb-ring{opacity:.5;animation:orb-ring-pulse 2.4s ease-out infinite}
main[data-live="live"] .orb{animation-duration:3.6s}
main[data-live="requesting"] .orb,main[data-live="connecting"] .orb{animation:orb-wake-core 1.6s ease-in-out infinite}
@keyframes orb-wake{0%{transform:scale(.62);opacity:.9}100%{transform:scale(1.3);opacity:0}}
@keyframes orb-ring-pulse{0%{transform:scale(.94);opacity:.5}70%{transform:scale(1.16);opacity:0}100%{opacity:0}}
@keyframes orb-wake-core{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}
@keyframes orb-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}
@keyframes orb-spin{to{transform:rotate(360deg)}}
main[data-live="requesting"] .orb,main[data-live="connecting"] .orb{animation-duration:2.8s}
main[data-live="live"] .orb-halo{opacity:.58}
main[data-live="requesting"] .orb-halo,main[data-live="connecting"] .orb-halo{opacity:.48}
main[data-live="failed"] .orb-halo{opacity:.52}
main[data-live="closing"] .orb{opacity:.74}
main[data-live="idle"] .orb-halo{opacity:.3}
.picker{box-sizing:border-box;width:244px;display:flex;flex-direction:column;background:var(--popover,#fffdf8);color:var(--popover-foreground,#1d1a15);border:1px solid var(--border,#e0d7c3);border-radius:12px;box-shadow:0 16px 40px -18px rgba(0,0,0,.55);padding:8px;overflow:visible}
.picker[hidden]{display:none}
.picker-label{margin:0;padding:2px 8px 8px;font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--muted-foreground,#6f665a)}
.picker-list{display:flex;flex-direction:column;gap:6px;overflow:visible}
.provider-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:32px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;padding:4px 8px;cursor:pointer}
.provider-row:hover:not(:disabled){background:color-mix(in srgb,var(--popover-foreground,#1d1a15) 7%,transparent)}
.provider-row[data-selected="true"]{background:color-mix(in srgb,var(--popover-foreground,#1d1a15) 9%,transparent);border-color:var(--border,#e0d7c3)}
.provider-row[data-available="false"]:not([data-selected="true"]){opacity:.72}
.provider-row:disabled{cursor:default}
.provider-row:focus-visible{outline:2px solid var(--popover-foreground,#1d1a15);outline-offset:1px}
.row-text{min-width:0;flex:1;display:flex;align-items:baseline;gap:6px;overflow:hidden}
.row-provider{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-model{min-width:0;color:var(--muted-foreground,#6f665a);font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-state{flex:none;display:flex;align-items:center;font-size:11px;font-weight:600;color:var(--muted-foreground,#6f665a)}
.row-check{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.provider-row[data-selected="true"] .row-state{color:var(--popover-foreground,#1d1a15)}
.picker-empty{margin:0;padding:4px 8px;font-size:13px;color:var(--muted-foreground,#6f665a)}
.picker-error{margin:6px 0 0;padding:0 8px;font-size:11px;color:#b3261e}
.picker-error[hidden]{display:none}
.picker-hint{margin:8px 0 0;padding:0 8px;font-size:11px;line-height:1.4;color:var(--muted-foreground,#6f665a)}
@media (prefers-color-scheme: dark){body{color:#f5f7f6}.picker{background:var(--popover,#17191d);color:var(--popover-foreground,#f5f7f6);border-color:var(--border,rgba(255,255,255,.1));box-shadow:0 18px 44px -18px rgba(0,0,0,.8)}.picker-label,.picker-hint,.picker-empty,.row-model,.row-state{color:var(--muted-foreground,#a39b8d)}.provider-row[data-selected="true"] .row-state{color:var(--popover-foreground,#f5f7f6)}.provider-row:focus-visible{outline-color:var(--popover-foreground,#f5f7f6)}.picker-error{color:#f2a9a2}}
@media (prefers-reduced-motion: reduce){.orb,.orb::before,.orb-halo,.orb-ring{animation:none!important;transition:none!important}main[data-live="live"] .orb{transform:none}}
</style></head><body><main data-orb-root data-live="idle" style="--accent:#8db5ae;--accent-secondary:#7388d7"><div class="orb-wrap"><div class="orb-halo" aria-hidden="true"></div><div class="orb-ring" aria-hidden="true"></div><canvas class="orb-canvas" data-orb-canvas aria-hidden="true"></canvas><button class="orb" data-orb aria-expanded="false" aria-label="ARIS. Activate to choose provider."></button></div><section class="picker" data-picker hidden><p class="picker-label">New tasks use</p><div class="picker-list" data-provider-list></div><p class="picker-error" data-picker-error hidden></p><p class="picker-hint">Ctrl+Shift+J talks. Orb picks provider.</p></section></main>${orbScript}</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function desktopJarvisOrbStateScript(state: DesktopJarvisLiveVoiceState): string {
  return `window.__jarvisOrb?.setLiveState(${JSON.stringify(state)})`;
}

export function desktopJarvisOrbCatalogScript(catalog: DesktopJarvisOrbCatalog): string {
  return `window.__jarvisOrb?.setCatalog(${JSON.stringify(catalog)})`;
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
