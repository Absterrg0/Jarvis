import type {
  DesktopCirceLiveVoiceState,
  DesktopCirceLiveVoiceStatus,
  DesktopCirceOrbCatalog,
  DesktopCirceOrbSelection,
} from "@t3tools/contracts";

/** Expanded window footprint: orb plus the provider and running-agent lists. */
export const DESKTOP_CIRCE_ORB_WINDOW_WIDTH = 384;
export const DESKTOP_CIRCE_ORB_WINDOW_HEIGHT = 440;
export const DESKTOP_CIRCE_ORB_MARGIN = 16;
/** Collapsed window footprint. Keep the native hit area close to the visible orb. */
export const DESKTOP_CIRCE_ORB_COLLAPSED_WIDTH = 72;
export const DESKTOP_CIRCE_ORB_COLLAPSED_HEIGHT = 72;

/** Console/stdout bridge prefix. Overlay JS logs selections; main parses them. */
export const DESKTOP_CIRCE_ORB_CONSOLE_PREFIX = "[circe-orb]";

export interface DesktopCirceOrbPresentation {
  readonly label: string;
  readonly accent: string;
  readonly accentSecondary: string;
  readonly animated: boolean;
}

// One calm accent across states. Status is read from the label and the orb's
// motion, not from a rotating rainbow, so the overlay reads as a single orb
// rather than a light show.
const ORB_ACCENT = "#9db4c7";
const ORB_ACCENT_DEEP = "#5f7186";
const ORB_ACCENT_FAILED = "#d59a9a";

const DESKTOP_CIRCE_ORB_PROFILES: Readonly<
  Record<DesktopCirceLiveVoiceStatus, { label: string; accent: string; accentSecondary: string }>
> = {
  idle: { label: "Circe is idle", accent: ORB_ACCENT, accentSecondary: ORB_ACCENT_DEEP },
  requesting: {
    label: "Starting live conversation",
    accent: ORB_ACCENT,
    accentSecondary: ORB_ACCENT_DEEP,
  },
  connecting: {
    label: "Connecting live conversation",
    accent: ORB_ACCENT,
    accentSecondary: ORB_ACCENT_DEEP,
  },
  live: { label: "Live conversation", accent: ORB_ACCENT, accentSecondary: ORB_ACCENT_DEEP },
  closing: {
    label: "Ending live conversation",
    accent: ORB_ACCENT,
    accentSecondary: ORB_ACCENT_DEEP,
  },
  failed: {
    label: "Live conversation failed",
    accent: ORB_ACCENT_FAILED,
    accentSecondary: ORB_ACCENT_FAILED,
  },
};

/**
 * Orb shading follows the real live session. The idle orb keeps a slow liquid
 * drift; an active session drives the mic level into the glow and ripple.
 * Motion still stops for reduced-motion users, where the static CSS orb keeps
 * state legible through color alone.
 */
export const desktopCirceOrbPresentation = (
  state: DesktopCirceLiveVoiceState,
): DesktopCirceOrbPresentation => {
  const profile = DESKTOP_CIRCE_ORB_PROFILES[state.status];
  const animated =
    state.active &&
    (state.status === "requesting" || state.status === "connecting" || state.status === "live");
  return { ...profile, animated };
};

const serializedOrbProfiles = JSON.stringify(DESKTOP_CIRCE_ORB_PROFILES).replaceAll("<", "\\u003c");

export interface DesktopCirceOverlayWorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopCirceOverlayBounds extends DesktopCirceOverlayWorkArea {}

/** Distance from the window's right edge to the orb centre, in both sizes. */
export const DESKTOP_CIRCE_ORB_CENTER_FROM_RIGHT = 36;

export interface DesktopCirceOverlayAnchor {
  readonly x: number;
  readonly y: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** The orb's screen centre for a window bounds. Used to persist a drag. */
export function desktopCirceOverlayOrbCenter(
  bounds: DesktopCirceOverlayBounds,
): DesktopCirceOverlayAnchor {
  return {
    x: bounds.x + bounds.width - DESKTOP_CIRCE_ORB_CENTER_FROM_RIGHT,
    y: bounds.y + bounds.height / 2,
  };
}

/**
 * The overlay is anchored by the orb's screen centre so a dragged orb stays
 * where the user dropped it while the panel grows and collapses around it.
 * Without an anchor it keeps the historical middle-right placement.
 */
export function resolveDesktopCirceOverlayBounds(
  workArea: DesktopCirceOverlayWorkArea,
  expanded: boolean,
  anchor?: DesktopCirceOverlayAnchor,
): DesktopCirceOverlayBounds {
  const width = Math.min(
    expanded ? DESKTOP_CIRCE_ORB_WINDOW_WIDTH : DESKTOP_CIRCE_ORB_COLLAPSED_WIDTH,
    Math.max(48, workArea.width - DESKTOP_CIRCE_ORB_MARGIN * 2),
  );
  const height = Math.min(
    expanded ? DESKTOP_CIRCE_ORB_WINDOW_HEIGHT : DESKTOP_CIRCE_ORB_COLLAPSED_HEIGHT,
    Math.max(48, workArea.height - DESKTOP_CIRCE_ORB_MARGIN * 2),
  );
  if (anchor === undefined) {
    return {
      x: Math.round(workArea.x + workArea.width - width - DESKTOP_CIRCE_ORB_MARGIN),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }
  return {
    x: Math.round(
      clamp(
        anchor.x - (width - DESKTOP_CIRCE_ORB_CENTER_FROM_RIGHT),
        workArea.x,
        workArea.x + workArea.width - width,
      ),
    ),
    y: Math.round(clamp(anchor.y - height / 2, workArea.y, workArea.y + workArea.height - height)),
    width,
    height,
  };
}

/** Fullscreen-triangle vertex shader for the orb canvas. */
const ORB_VERTEX_SHADER = "attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos,0.0,1.0); }";

/**
 * Liquid-glass orb. A displaced sphere is shaded with environment reflection,
 * thin-film iridescence, and an inner glow, then tone mapped. The whole shader
 * is analytic: no ray marching, so a 72px canvas stays cheap enough to animate.
 */
const ORB_FRAGMENT_SHADER = `precision highp float;

uniform vec2  u_res;
uniform float u_time;
uniform float u_level;
uniform float u_active;
uniform vec3  u_a;
uniform vec3  u_b;

float hash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 x){
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f*f*(3.0 - 2.0*f);
  return mix(mix(mix(hash13(i+vec3(0,0,0)), hash13(i+vec3(1,0,0)), f.x),
                 mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), f.x),
                 mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){
  float s = 0.0, a = 0.5;
  for(int i=0;i<4;i++){
    s += a*vnoise(p);
    p = p*2.02 + vec3(4.7, 9.2, 2.3);
    a *= 0.5;
  }
  return s;
}
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }

float liquid(vec3 dir, float t){
  vec3 p = dir;
  p.xz = rot(t*0.20) * p.xz;
  p.xy = rot(t*0.11) * p.xy;
  p.y += t*0.09;
  float w = fbm(p*2.3);
  float q = fbm(p*3.9 + w*1.6 + vec3(0.0, -t*0.10, 0.0));
  return q;
}
float surfaceR(vec3 dir, float t){
  float d = liquid(dir, t) - 0.5;
  float r = fbm(dir*5.0 + vec3(t*0.13)) - 0.5;
  return 0.66 + d*0.032 + r*0.010*(0.5 + u_active*0.5);
}
float field(vec3 p, float t){
  return length(p) - surfaceR(normalize(p + 1e-6), t);
}
vec3 fieldNormal(vec3 p, float t){
  vec2 e = vec2(0.0022, 0.0);
  return normalize(vec3(
    field(p+e.xyy,t)-field(p-e.xyy,t),
    field(p+e.yxy,t)-field(p-e.yxy,t),
    field(p+e.yyx,t)-field(p-e.yyx,t)));
}
// Neutral studio environment: a soft floor-to-sky gradient with one key light.
// No coloured fill lights, so the glass never turns into a light show.
vec3 env(vec3 d){
  float y = d.y;
  vec3 col = mix(vec3(0.030,0.034,0.040), vec3(0.34,0.38,0.44), smoothstep(-0.8, 1.0, y));
  col += vec3(1.0,0.99,0.97) * smoothstep(0.90, 0.999, dot(d, normalize(vec3(-0.40,0.80,0.46)))) * 1.5;
  return col;
}
vec3 aces(vec3 x){
  return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
}
void main(){
  vec2 uv = (2.0*gl_FragCoord.xy - u_res)/u_res.y;
  float r = length(uv);
  vec2 dir2 = uv/max(r,1e-5);
  float Rl = surfaceR(vec3(dir2,0.12), u_time);
  float inside = smoothstep(Rl+0.005, Rl-0.005, r);

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  if(inside > 0.001){
    float rr = min(r, Rl-1e-4);
    float z = sqrt(max(0.0, Rl*Rl - rr*rr));
    vec3 p = vec3(uv, z)/Rl;
    vec3 n = fieldNormal(p, u_time);
    vec3 V = normalize(vec3(uv*0.45, 1.0));
    vec3 I = -V;

    vec3 ldir = normalize(vec3(-0.5, 0.78, 0.62));
    float ndl = max(dot(n, ldir), 0.0);
    float ndv = max(dot(n, V), 0.0);
    vec3 ref = reflect(I, n);
    vec3 reflCol = env(ref);
    float fres = pow(1.0 - ndv, 4.0);

    // Neutral reflective glass with a single crisp key specular and one soft
    // fill. The accent only tints the grazing rim and a faint inner glow.
    vec3 colr = reflCol;
    colr += vec3(1.0,0.99,0.96) * pow(max(dot(ref, V), 0.0), 180.0) * 1.7;
    colr += vec3(0.78,0.84,0.90) * pow(max(dot(ref, normalize(vec3(0.80,0.22,0.42))), 0.0), 24.0) * 0.16;

    float rimT = pow(1.0 - ndv, 5.0);
    colr += u_a * rimT * (0.28 + u_level * 0.75);

    float inner = fbm(p*3.0 + n*1.6 + vec3(u_time*0.10));
    colr += mix(u_a, u_b, 0.5) * pow(inner, 5.0) * (0.05 + u_level * 0.45);

    col = aces(colr);
    alpha = inside;
  }

  // A hair of neutral edge light just outside the silhouette. There is no
  // coloured halo band, so the overlay never shows a glow bar behind the orb.
  float edge = smoothstep(0.020, 0.0, abs(r - Rl));
  col += mix(vec3(0.62,0.68,0.74), u_a, 0.30) * edge * 0.06;
  alpha = clamp(alpha + edge * 0.10, 0.0, 1.0);

  gl_FragColor = vec4(col*alpha, alpha);
}
`;

const orbScript = `<script>
(() => {
  const main = document.querySelector("[data-orb-root]");
  const orb = document.querySelector("[data-orb]");
  const canvas = document.querySelector("[data-orb-canvas]");
  const picker = document.querySelector("[data-picker]");
  const list = document.querySelector("[data-provider-list]");
  const runningSection = document.querySelector("[data-running-section]");
  const runningList = document.querySelector("[data-running-list]");
  const errorRow = document.querySelector("[data-picker-error]");
  const liveLabel = document.querySelector("[data-live-label]");
  const fragSource = document.getElementById("orb-frag");
  const prefix = ${JSON.stringify(DESKTOP_CIRCE_ORB_CONSOLE_PREFIX)};
  if (!main || !orb || !canvas || !picker || !list || !runningSection || !runningList || !errorRow || !liveLabel) return;

  const profiles = ${serializedOrbProfiles};
  let liveState = { enabled: false, active: false, status: "idle" };
  let catalog = { providers: [], selected: null, pendingSelection: null, error: null };
  let expanded = false;
  let collapseTimer = 0;

  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const hexToRgb = (hex) => {
    const value = String(hex || "#7fc7c0").replace("#", "");
    const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
    const int = parseInt(full, 16);
    return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  let gl = null;
  let uniforms = null;
  let rafId = 0;
  let running = false;
  let lastTickAt = 0;
  let lastDrawAt = 0;
  let accentA = [0.5, 0.78, 0.75];
  let accentB = [0.44, 0.53, 0.85];
  let targetA = accentA;
  let targetB = accentB;

  const isActiveStatus = () =>
    liveState.active &&
    (liveState.status === "requesting" ||
      liveState.status === "connecting" ||
      liveState.status === "live");
  const readLevel = () =>
    typeof liveState.level === "number" && isFinite(liveState.level)
      ? Math.max(0, Math.min(1, liveState.level))
      : 0;

  const drawFrame = (now) => {
    const profile = profiles[liveState.status] || profiles.idle;
    targetA = hexToRgb(profile.accent);
    targetB = hexToRgb(profile.accentSecondary);
    const dt = lastTickAt === 0 ? 0.016 : Math.min(0.05, (now - lastTickAt) / 1000);
    lastTickAt = now;
    const k = 1 - Math.pow(0.0015, dt);
    accentA = lerp3(accentA, targetA, k);
    accentB = lerp3(accentB, targetB, k);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.res, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, now / 1000);
    gl.uniform1f(uniforms.level, readLevel());
    gl.uniform1f(uniforms.active, isActiveStatus() ? 1 : 0);
    gl.uniform3f(uniforms.a, accentA[0], accentA[1], accentA[2]);
    gl.uniform3f(uniforms.b, accentB[0], accentB[1], accentB[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const frame = (now) => {
    if (!running || gl === null) return;
    rafId = requestAnimationFrame(frame);
    // Full motion while a session runs or the panel is open; the idle orb
    // drifts at half rate so a resident overlay stays cheap.
    const budget = isActiveStatus() || expanded ? 0 : 1000 / 30;
    if (now - lastDrawAt < budget) return;
    lastDrawAt = now;
    drawFrame(now);
  };

  const setRunning = (next) => {
    if (gl === null || reduceMotion) return;
    const desired = next && !document.hidden;
    if (desired === running) return;
    running = desired;
    if (desired) {
      lastTickAt = 0;
      lastDrawAt = 0;
      rafId = requestAnimationFrame(frame);
    } else if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  const initOrb = () => {
    if (reduceMotion || !fragSource) {
      main.classList.add("no-webgl");
      return;
    }
    try {
      gl = canvas.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        depth: false,
        stencil: false,
      });
      if (gl === null) {
        main.classList.add("no-webgl");
        return;
      }
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
      };
      const vs = compile(gl.VERTEX_SHADER, ${JSON.stringify(ORB_VERTEX_SHADER)});
      const fs = compile(gl.FRAGMENT_SHADER, fragSource.textContent);
      if (vs === null || fs === null) {
        gl = null;
        main.classList.add("no-webgl");
        return;
      }
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl = null;
        main.classList.add("no-webgl");
        return;
      }
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "a_pos");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      uniforms = {
        res: gl.getUniformLocation(program, "u_res"),
        time: gl.getUniformLocation(program, "u_time"),
        level: gl.getUniformLocation(program, "u_level"),
        active: gl.getUniformLocation(program, "u_active"),
        a: gl.getUniformLocation(program, "u_a"),
        b: gl.getUniformLocation(program, "u_b"),
      };
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const size = canvas.clientWidth || 72;
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      main.classList.add("webgl");
    } catch (error) {
      gl = null;
      main.classList.add("no-webgl");
    }
  };
  initOrb();

  const selectionKey = (selection) =>
    selection === null || selection === undefined
      ? ""
      : selection.instanceId + "\\u0000" + selection.model;

  const renderStatus = () => {
    const profile = profiles[liveState.status] || profiles.idle;
    main.dataset.live = liveState.status;
    main.dataset.active = liveState.active ? "true" : "false";
    main.style.setProperty("--accent", profile.accent);
    main.style.setProperty("--accent-secondary", profile.accentSecondary);
    main.style.setProperty("--level", String(readLevel()));
    orb.dataset.live = liveState.status;
    orb.classList.toggle("is-live", isActiveStatus());
    if (gl !== null) setRunning(true);
    const workingCount = Array.isArray(catalog.agents)
      ? catalog.agents.filter((agent) => agent.status !== "offline").length
      : 0;
    const label =
      liveState.status === "idle" && workingCount > 0
        ? workingCount + (workingCount === 1 ? " agent active" : " agents active")
        : profile.label;
    liveLabel.textContent = label;
    orb.title = label;
    orb.setAttribute(
      "aria-label",
      label + ". Activate to choose providers and running agents.",
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
        const key = provider.instanceId + "\\u0000" + model.slug;
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

  const notifyExpanded = (value) => {
    console.log(prefix + " " + JSON.stringify({ type: "expanded", expanded: value }));
  };

  const setExpanded = (next) => {
    if (next === expanded) return;
    expanded = next;
    if (next) {
      if (collapseTimer !== 0) {
        clearTimeout(collapseTimer);
        collapseTimer = 0;
      }
      picker.hidden = false;
      orb.setAttribute("aria-expanded", "true");
      // Let the host grow the native window first, then animate the panel in.
      main.dataset.expanded = "false";
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          main.dataset.expanded = "true";
        }),
      );
      notifyExpanded(true);
      setRunning(true);
    } else {
      orb.setAttribute("aria-expanded", "false");
      main.dataset.expanded = "false";
      // Keep the native window open until the panel finishes sliding out so
      // the motion is never clipped by the shrink.
      collapseTimer = setTimeout(() => {
        picker.hidden = true;
        collapseTimer = 0;
        notifyExpanded(false);
        orb.focus({ preventScroll: true });
      }, 240);
    }
  };

  // Drag to move the overlay; a press that does not move toggles the panel.
  // Pointer capture keeps moves flowing after the cursor leaves the small
  // native window, so the orb can be dropped anywhere on the display.
  const DRAG_THRESHOLD_PX = 4;
  const postDrag = (payload) => console.log(prefix + " " + JSON.stringify(payload));
  let dragPointerId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragging = false;
  let suppressClick = false;
  orb.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragPointerId !== null) return;
    dragPointerId = event.pointerId;
    dragStartX = event.screenX;
    dragStartY = event.screenY;
    dragging = false;
    try {
      orb.setPointerCapture(event.pointerId);
    } catch {}
  });
  orb.addEventListener("pointermove", (event) => {
    if (dragPointerId === null || event.pointerId !== dragPointerId) return;
    const dx = event.screenX - dragStartX;
    const dy = event.screenY - dragStartY;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!dragging) {
      dragging = true;
      orb.classList.add("dragging");
      postDrag({ type: "drag", phase: "start", x: dragStartX, y: dragStartY });
    }
    postDrag({ type: "drag", phase: "move", x: event.screenX, y: event.screenY });
  });
  const finishDrag = (event) => {
    if (dragPointerId === null || (event && event.pointerId !== dragPointerId)) return;
    const moved = dragging;
    try {
      orb.releasePointerCapture(dragPointerId);
    } catch {}
    dragPointerId = null;
    dragging = false;
    orb.classList.remove("dragging");
    if (moved) {
      postDrag({ type: "drag", phase: "end" });
      // A drag ends with a click; swallow it so the panel does not toggle.
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 0);
    }
  };
  orb.addEventListener("pointerup", finishDrag);
  orb.addEventListener("pointercancel", finishDrag);
  orb.addEventListener("click", () => {
    if (suppressClick) return;
    setExpanded(!expanded);
  });
  document.addEventListener("visibilitychange", () => setRunning(true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && expanded) setExpanded(false);
    if (event.key === "Tab") {
      const controls = expanded ? [orb, ...picker.querySelectorAll("button:not(:disabled)")] : [orb];
      const index = controls.indexOf(document.activeElement);
      event.preventDefault();
      controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length].focus();
    }
  });

  window.__circeOrb = {
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

/** Local activity panel. Updates come from the host; idle drifts at half rate. */
export function desktopCirceOverlayDataUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';connect-src 'none';img-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
body{color:#f3f1ed;font:400 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}main{position:absolute;inset:0;--accent:#9db4c7;--accent-secondary:#5f7186;--level:0}
.orb-wrap{position:absolute;right:0;top:calc(50% - 36px);width:72px;height:72px;display:grid;place-items:center;transition:transform .26s cubic-bezier(.22,.9,.28,1)}
.orb-canvas{position:absolute;inset:0;width:72px;height:72px;pointer-events:none}
.orb{position:relative;z-index:2;width:52px;height:52px;border:1px solid rgba(255,255,255,.16);border-radius:50%;cursor:grab;padding:0;outline:none;background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.55),rgba(255,255,255,0) 42%),radial-gradient(circle at 50% 46%,#3a4450,#0b0d11 78%);box-shadow:0 8px 24px rgba(0,0,0,.45),inset 0 1px 2px rgba(255,255,255,.18),inset 0 -6px 14px rgba(0,0,0,.40);transition:box-shadow .2s ease;touch-action:none;user-select:none;-webkit-user-select:none}
main.webgl .orb{background:transparent;border-color:transparent;box-shadow:none}
.orb:hover{box-shadow:0 10px 28px rgba(0,0,0,.48),inset 0 1px 2px rgba(255,255,255,.22),inset 0 -6px 14px rgba(0,0,0,.40)}
.orb.dragging{cursor:grabbing}
.orb:focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 75%,white);outline-offset:3px}
main[data-expanded="true"] .orb-wrap{transform:scale(1.08)}
.picker{position:absolute;left:0;top:0;bottom:0;width:calc(100% - 84px);padding:18px 12px;overflow:auto;scrollbar-width:thin;scrollbar-color:#44443d transparent;border:1px solid #3c3c35;border-radius:13px;background:#151512;color:#f3f1ed;opacity:0;transform:translateX(10px) scale(.985);transform-origin:100% 50%;transition:opacity .18s ease,transform .24s cubic-bezier(.22,.9,.28,1)}
main[data-expanded="true"] .picker{opacity:1;transform:none}
.picker[hidden]{display:none}.picker-brand{display:flex;justify-content:space-between;align-items:center;margin:0 6px 4px;font-size:15px;font-weight:600;letter-spacing:-.02em}.picker-brand span{color:#aaa89f;font-size:11px;font-weight:400;letter-spacing:0}
.live-label{margin:0 6px 22px;color:#aaa89f;font-size:11px}.picker-label,.running-label{margin:0 6px 8px;color:#aaa89f;font-size:12px;font-weight:500}
.picker-list,.running-list{display:flex;flex-direction:column;gap:3px}
.provider-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:47px;width:100%;padding:8px 10px;text-align:left;color:#f3f1ed;background:transparent;border:1px solid transparent;border-radius:7px;cursor:pointer}
.provider-row:hover:not(:disabled),.provider-row[data-selected="true"]{background:#292922}.provider-row:disabled{cursor:default;opacity:.5}.provider-row:focus-visible{outline:2px solid #aaa89f;outline-offset:-2px}.row-text{display:grid;gap:2px;min-width:0}.row-provider{font-size:12px;font-weight:500}.row-model{font-size:11px;color:#aaa89f}.row-state{font-size:10px;color:#c9c7bc}.row-check{width:14px;height:14px;fill:none;stroke:#c9c7bc;stroke-width:1.5}.picker-empty{margin:0;padding:8px 6px;color:#aaa89f;font-size:12px}.picker-error{padding:8px;color:#cf8b80;font-size:11px}.picker-error[hidden]{display:none}.picker-hint{margin:20px 6px 0;color:#8d8c82;font-size:10px}
.running-section{margin-top:18px;padding-top:18px;border-top:1px solid #34342d}.agent-row{display:flex;align-items:center;gap:8px;padding:9px 6px}.agent-marker{width:5px;height:5px;flex:none;border-radius:50%;background:#91ba79}.agent-row[data-status="offline"] .agent-marker{background:#8d8c82}.agent-row[data-status="waiting"] .agent-marker{background:#c9ad73}.agent-text{min-width:0;flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agent-text small{display:block;color:#aaa89f;font-size:10px;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.agent-status{font-size:10px;color:#aaa89f;text-transform:capitalize}
@media(prefers-reduced-motion: reduce){.orb-wrap,.picker,.orb{transition:none!important}main[data-expanded="true"] .orb-wrap{transform:none}}
</style></head><body><main data-orb-root data-live="idle" data-expanded="false"><div class="orb-wrap"><canvas class="orb-canvas" data-orb-canvas aria-hidden="true"></canvas><button class="orb" data-orb aria-expanded="false" aria-label="Circe. Activate to choose providers and running agents."></button></div><section class="picker" aria-label="Circe activity" data-picker hidden><div class="picker-brand">Circe<span>Activity</span></div><p class="live-label" data-live-label></p><p class="picker-label">Providers</p><div class="picker-list" data-provider-list></div><section class="running-section" data-running-section hidden><p class="running-label">Running agents</p><div class="running-list" data-running-list></div></section><p class="picker-error" data-picker-error hidden></p><p class="picker-hint">Ctrl+Shift+J toggles voice.</p></section></main><script type="x-shader/x-fragment" id="orb-frag">${ORB_FRAGMENT_SHADER}</script>${orbScript}</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function desktopCirceOrbStateScript(state: DesktopCirceLiveVoiceState): string {
  return `window.__circeOrb?.setLiveState(${JSON.stringify(state)})`;
}

export function desktopCirceOrbCatalogScript(catalog: DesktopCirceOrbCatalog): string {
  return `window.__circeOrb?.setCatalog(${JSON.stringify(catalog)})`;
}

export interface DesktopCirceOrbExpansionEvent {
  readonly type: "expanded";
  readonly expanded: boolean;
}

export interface DesktopCirceOrbDragEvent {
  readonly type: "drag";
  readonly phase: "start" | "move" | "end";
  readonly x?: number;
  readonly y?: number;
}

/** Parse the overlay's bounded expansion and move events separately from picks. */
export function parseDesktopCirceOverlayEvent(
  line: string,
): DesktopCirceOrbSelection | DesktopCirceOrbExpansionEvent | DesktopCirceOrbDragEvent | null {
  const prefix = line.startsWith(DESKTOP_CIRCE_ORB_CONSOLE_PREFIX)
    ? DESKTOP_CIRCE_ORB_CONSOLE_PREFIX
    : null;
  if (prefix === null) return null;
  const payload = line.slice(prefix.length).trim();
  try {
    const value = JSON.parse(payload) as Partial<DesktopCirceOrbEventLike> & {
      readonly expanded?: unknown;
      readonly phase?: unknown;
      readonly x?: unknown;
      readonly y?: unknown;
    };
    if (value.type === "expanded" && typeof value.expanded === "boolean") {
      return { type: "expanded", expanded: value.expanded };
    }
    if (
      value.type === "drag" &&
      (value.phase === "start" || value.phase === "move" || value.phase === "end")
    ) {
      if (value.phase === "end") return { type: "drag", phase: "end" };
      if (typeof value.x === "number" && typeof value.y === "number") {
        return { type: "drag", phase: value.phase, x: value.x, y: value.y };
      }
      return null;
    }
  } catch {
    return null;
  }
  return parseDesktopCirceOrbEvent(line);
}

/** Parse one console/stdout line from the orb document into a selection. */
export function parseDesktopCirceOrbEvent(line: string): DesktopCirceOrbSelection | null {
  const prefix = line.startsWith(DESKTOP_CIRCE_ORB_CONSOLE_PREFIX)
    ? DESKTOP_CIRCE_ORB_CONSOLE_PREFIX
    : null;
  if (prefix === null) return null;
  const payload = line.slice(prefix.length).trim();
  try {
    const value = JSON.parse(payload) as Partial<DesktopCirceOrbEventLike>;
    if (value.type !== "select") return null;
    if (typeof value.instanceId !== "string" || value.instanceId.length === 0) return null;
    if (typeof value.model !== "string" || value.model.length === 0) return null;
    if (value.instanceId.length > 256 || value.model.length > 256) return null;
    return { instanceId: value.instanceId, model: value.model };
  } catch {
    return null;
  }
}

type DesktopCirceOrbEventLike = {
  readonly type?: unknown;
  readonly instanceId?: unknown;
  readonly model?: unknown;
};
