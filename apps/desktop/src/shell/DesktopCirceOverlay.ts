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

const DESKTOP_CIRCE_ORB_PROFILES: Readonly<
  Record<DesktopCirceLiveVoiceStatus, { label: string; accent: string; accentSecondary: string }>
> = {
  idle: { label: "Circe is idle", accent: "#7fc7c0", accentSecondary: "#6f86d8" },
  requesting: {
    label: "Starting live conversation",
    accent: "#8fd9cf",
    accentSecondary: "#6fa0f2",
  },
  connecting: {
    label: "Connecting live conversation",
    accent: "#78d6cd",
    accentSecondary: "#648ff4",
  },
  live: { label: "Live conversation", accent: "#7fe6d2", accentSecondary: "#7aa6f7" },
  closing: { label: "Ending live conversation", accent: "#9fb0ff", accentSecondary: "#c894ea" },
  failed: { label: "Live conversation failed", accent: "#ff9d9d", accentSecondary: "#ef7186" },
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

export function resolveDesktopCirceOverlayBounds(
  workArea: DesktopCirceOverlayWorkArea,
  expanded: boolean,
): DesktopCirceOverlayBounds {
  const width = Math.min(
    expanded ? DESKTOP_CIRCE_ORB_WINDOW_WIDTH : DESKTOP_CIRCE_ORB_COLLAPSED_WIDTH,
    Math.max(48, workArea.width - DESKTOP_CIRCE_ORB_MARGIN * 2),
  );
  const height = Math.min(
    expanded ? DESKTOP_CIRCE_ORB_WINDOW_HEIGHT : DESKTOP_CIRCE_ORB_COLLAPSED_HEIGHT,
    Math.max(48, workArea.height - DESKTOP_CIRCE_ORB_MARGIN * 2),
  );
  return {
    x: Math.round(workArea.x + workArea.width - width - DESKTOP_CIRCE_ORB_MARGIN),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
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
vec3 env(vec3 d){
  float y = d.y;
  vec3 col = mix(vec3(0.008,0.010,0.018), vec3(0.14,0.17,0.24), smoothstep(-0.7, 0.85, y));
  float top = smoothstep(0.4, 1.0, y);
  col += vec3(0.85,0.92,1.0)*top*0.7;
  float key = smoothstep(0.86, 0.999, dot(d, normalize(vec3(-0.45,0.75,0.48))));
  col += vec3(1.0)*key*2.6;
  float fill = smoothstep(0.66, 0.999, dot(d, normalize(vec3(0.85,0.1,0.5))));
  col += mix(u_a, vec3(1.0), 0.15)*fill*1.25;
  float bounce = smoothstep(0.5, 0.99, dot(d, normalize(vec3(-0.1,-0.85,0.5))));
  col += u_b*bounce*0.8;
  return col;
}
vec3 thinFilm(float thickness, float cosTheta){
  float eta = 1.34;
  float sinT2 = (1.0 - cosTheta*cosTheta)/(eta*eta);
  float cosT = sqrt(max(0.0, 1.0 - sinT2));
  float opd = 2.0*eta*thickness*cosT;
  vec3 lam = vec3(650.0, 545.0, 450.0);
  vec3 phi = 6.2831853 * opd / lam;
  return 0.5 + 0.5*cos(phi);
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

    float flow = fbm(p*1.7 + vec3(u_time*0.08));
    float thick = 150.0 + flow*300.0 + fres*260.0 + u_level*70.0;
    vec3 film = thinFilm(thick, ndv);

    // Dark reflective glass. Thin film only tints the body; it does not
    // repaint it, so the orb stays legible and not garish.
    vec3 colr = reflCol * mix(vec3(1.0), film, 0.22);
    colr += u_a*ndl*0.10;

    // Crisp studio speculars.
    float spec = pow(max(dot(ref, V), 0.0), 220.0);
    colr += vec3(1.0,0.99,0.96)*spec*2.4;
    float spec2 = pow(max(dot(ref, normalize(vec3(0.85,0.25,0.4))), 0.0), 48.0);
    colr += mix(u_a, vec3(1.0), 0.35)*spec2*0.5;

    // Iridescence lives at the grazing rim.
    colr += film*fres*1.35;
    colr += mix(u_a,u_b,0.5)*pow(1.0-ndv, 6.0)*0.9;

    // Faint liquid glow inside the glass, brightest when speaking.
    float inner = fbm(p*3.2 + n*1.7 + vec3(u_time*0.14));
    colr += mix(u_a,u_b,0.4)*pow(inner, 4.0)*(0.35 + u_level*1.3);
    float core = pow(max(0.0, 1.0 - r/Rl), 2.0);
    colr += mix(u_a,u_b,0.5)*core*(0.06 + u_level*0.85)*0.7;

    col = aces(colr);
    alpha = inside;
  }

  float d0 = max(r - Rl, 0.0);
  float glow = smoothstep(0.0, 0.05, d0) * (1.0 - smoothstep(0.05, 0.30, d0));
  vec3 halo = mix(u_a,u_b,0.5);
  col += halo*pow(glow, 1.3)*(0.18 + u_level*0.42);
  float rim = smoothstep(0.02, 0.0, abs(r - Rl));
  col += halo*rim*0.05;
  alpha = clamp(alpha + glow*0.55, 0.0, 1.0);

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

  orb.addEventListener("click", () => setExpanded(!expanded));
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
*{box-sizing:border-box}main{position:absolute;inset:0;--accent:#7fc7c0;--accent-secondary:#6f86d8;--level:0}
.orb-wrap{position:absolute;right:0;top:calc(50% - 36px);width:72px;height:72px;display:grid;place-items:center;transition:transform .26s cubic-bezier(.22,.9,.28,1)}
.orb-halo{position:absolute;inset:10px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--accent) 55%,transparent),transparent 72%);filter:blur(9px);opacity:.45;transition:opacity .25s ease}
main.webgl .orb-halo{display:none}
.orb-canvas{position:absolute;inset:0;width:72px;height:72px;pointer-events:none}
.orb{position:relative;z-index:2;width:52px;height:52px;border:1px solid rgba(255,255,255,.18);border-radius:50%;cursor:pointer;padding:0;outline:none;background:radial-gradient(circle at 32% 26%,rgba(255,255,255,.85),rgba(255,255,255,0) 34%),radial-gradient(circle at 70% 74%,var(--accent-secondary),rgba(11,13,17,0) 60%),radial-gradient(circle at 50% 48%,var(--accent),#0b0d11 82%);box-shadow:0 8px 24px rgba(0,0,0,.5),0 0 18px color-mix(in srgb,var(--accent) 34%,transparent),inset 0 1px 2px rgba(255,255,255,.22),inset 0 -6px 14px rgba(0,0,0,.42);transition:box-shadow .2s ease}
main.webgl .orb{background:transparent;border-color:transparent;box-shadow:none}
.orb:hover{box-shadow:0 10px 28px rgba(0,0,0,.52),0 0 30px color-mix(in srgb,var(--accent) 54%,transparent),inset 0 1px 2px rgba(255,255,255,.26),inset 0 -6px 14px rgba(0,0,0,.42)}
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
</style></head><body><main data-orb-root data-live="idle" data-expanded="false"><div class="orb-wrap"><div class="orb-halo" aria-hidden="true"></div><canvas class="orb-canvas" data-orb-canvas aria-hidden="true"></canvas><button class="orb" data-orb aria-expanded="false" aria-label="Circe. Activate to choose providers and running agents."></button></div><section class="picker" aria-label="Circe activity" data-picker hidden><div class="picker-brand">Circe<span>Activity</span></div><p class="live-label" data-live-label></p><p class="picker-label">Providers</p><div class="picker-list" data-provider-list></div><section class="running-section" data-running-section hidden><p class="running-label">Running agents</p><div class="running-list" data-running-list></div></section><p class="picker-error" data-picker-error hidden></p><p class="picker-hint">Ctrl+Shift+J toggles voice.</p></section></main><script type="x-shader/x-fragment" id="orb-frag">${ORB_FRAGMENT_SHADER}</script>${orbScript}</body></html>`;
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

/** Parse the overlay's bounded expansion event separately from provider picks. */
export function parseDesktopCirceOverlayEvent(
  line: string,
): DesktopCirceOrbSelection | DesktopCirceOrbExpansionEvent | null {
  const prefix = line.startsWith(DESKTOP_CIRCE_ORB_CONSOLE_PREFIX)
    ? DESKTOP_CIRCE_ORB_CONSOLE_PREFIX
    : null;
  if (prefix === null) return null;
  const payload = line.slice(prefix.length).trim();
  try {
    const value = JSON.parse(payload) as Partial<DesktopCirceOrbEventLike> & {
      readonly expanded?: unknown;
    };
    if (value.type === "expanded" && typeof value.expanded === "boolean") {
      return { type: "expanded", expanded: value.expanded };
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
