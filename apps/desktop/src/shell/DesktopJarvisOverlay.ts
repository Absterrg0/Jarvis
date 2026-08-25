import type { DesktopJarvisVoiceState, DesktopJarvisVoiceStatus } from "@t3tools/contracts";
import {
  JARVIS_PRESENCE_FRAGMENT_SHADER,
  JARVIS_PRESENCE_PALETTE,
  JARVIS_PRESENCE_SHADER_MOTION,
  JARVIS_PRESENCE_VERTEX_SHADER,
  type JarvisPresenceMode,
} from "@t3tools/jarvis-client-runtime/presence";

export interface DesktopJarvisOverlayPresentation {
  readonly label: string;
  readonly accent: string;
  readonly accentSecondary: string;
  readonly animated: boolean;
  readonly settled: boolean;
}

interface DesktopJarvisOverlayProfile {
  readonly label: string;
  readonly mode: JarvisPresenceMode;
  readonly accent: string;
  readonly accentSecondary: string;
  readonly animated: boolean;
}

const DESKTOP_JARVIS_OVERLAY_PROFILES: Readonly<
  Record<DesktopJarvisVoiceStatus, DesktopJarvisOverlayProfile>
> = {
  starting: {
    label: "Preparing Jarvis voice",
    mode: "listening",
    accent: "#8dd8cf",
    accentSecondary: "#6b9bf2",
    animated: true,
  },
  capturing: {
    label: "Listening · press again to send",
    mode: "listening",
    accent: "#71d6cd",
    accentSecondary: "#618df4",
    animated: true,
  },
  transcribing: {
    label: "Jarvis is understanding",
    mode: "working",
    accent: "#9ba9ff",
    accentSecondary: "#c18bed",
    animated: true,
  },
  speaking: {
    label: "Jarvis is speaking",
    mode: "speaking",
    accent: "#f3b778",
    accentSecondary: "#dd7dcb",
    animated: true,
  },
  error: {
    label: "Jarvis voice needs attention",
    mode: "error",
    accent: "#ff9c9c",
    accentSecondary: "#ec6e83",
    animated: false,
  },
  unavailable: {
    label: "Jarvis voice is unavailable",
    mode: "error",
    accent: "#ffb08d",
    accentSecondary: "#d97879",
    animated: false,
  },
  ready: {
    label: "Jarvis is ready",
    mode: "idle",
    accent: "#8db5ae",
    accentSecondary: "#7388d7",
    animated: false,
  },
};

const serializedOverlayProfiles = JSON.stringify(DESKTOP_JARVIS_OVERLAY_PROFILES).replaceAll(
  "<",
  "\\u003c",
);
const serializedPresencePalette = JSON.stringify(JARVIS_PRESENCE_PALETTE);
const serializedVertexShader = JSON.stringify(JARVIS_PRESENCE_VERTEX_SHADER).replaceAll(
  "<",
  "\\u003c",
);
const serializedFragmentShader = JSON.stringify(JARVIS_PRESENCE_FRAGMENT_SHADER).replaceAll(
  "<",
  "\\u003c",
);

/**
 * The overlay is intentionally a small, self-contained document. It never
 * needs the main renderer (or a network request) to communicate its current
 * voice state, which keeps the hotkey surface responsive while the app is
 * hidden or still booting.
 */
export const desktopJarvisOverlayPresentation = (
  state: DesktopJarvisVoiceState,
): DesktopJarvisOverlayPresentation => ({
  ...DESKTOP_JARVIS_OVERLAY_PROFILES[state.status],
  settled: !DESKTOP_JARVIS_OVERLAY_PROFILES[state.status].animated,
});

const overlayScript = String.raw`<script>
(() => {
  const root = document.querySelector("main");
  const canvas = document.querySelector("canvas");
  const label = document.querySelector("[data-label]");
  if (!root || !canvas || !label) return;

  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, preserveDrawingBuffer: false });
  const fallback = gl === null ? canvas.getContext("2d", { alpha: true }) : null;
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const profiles = ${serializedOverlayProfiles};
  const palette = ${serializedPresencePalette};
  const vertexSource = ${serializedVertexShader};
  const fragmentSource = ${serializedFragmentShader};
  const frameInterval = ${JARVIS_PRESENCE_SHADER_MOTION.frameIntervalMs};
  const maxFrames = ${JARVIS_PRESENCE_SHADER_MOTION.maxFrames};
  const burstDuration = ${JARVIS_PRESENCE_SHADER_MOTION.burstDurationMs};
  let current = "ready";
  let visible = document.visibilityState !== "hidden";
  let frame = 0;
  let lastFrame = 0;
  let burstStartedAt = 0;
  let burstFrames = 0;
  let disposed = false;
  let contextLost = gl === null && fallback === null;
  let program = null;
  let buffer = null;
  let position = -1;
  let timeLocation = null;
  let progressLocation = null;
  let resolutionLocation = null;
  let colorLocation = null;
  let removeMotionListener = () => {};
  if (contextLost) root.classList.add("canvas-fallback");

  const stop = () => {
    if (frame !== 0) window.cancelAnimationFrame(frame);
    frame = 0;
  };

  const isAnimated = () => profiles[current].animated && visible && !reducedMotionQuery.matches && !contextLost && !disposed;

  const compile = (type, source) => {
    if (gl === null) return null;
    const shader = gl.createShader(type);
    if (shader === null) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const setupWebgl = () => {
    if (gl === null) return false;
    const vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
    if (vertexShader === null || fragmentShader === null) return false;
    const nextProgram = gl.createProgram();
    if (nextProgram === null) return false;
    gl.attachShader(nextProgram, vertexShader);
    gl.attachShader(nextProgram, fragmentShader);
    gl.linkProgram(nextProgram);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(nextProgram, gl.LINK_STATUS)) {
      gl.deleteProgram(nextProgram);
      return false;
    }
    const nextPosition = gl.getAttribLocation(nextProgram, "a_position");
    const nextTime = gl.getUniformLocation(nextProgram, "u_time");
    const nextProgress = gl.getUniformLocation(nextProgram, "u_progress");
    const nextResolution = gl.getUniformLocation(nextProgram, "u_resolution");
    const nextColor = gl.getUniformLocation(nextProgram, "u_color");
    const nextBuffer = gl.createBuffer();
    if (nextPosition < 0 || nextTime === null || nextProgress === null || nextResolution === null || nextColor === null || nextBuffer === null) {
      gl.deleteBuffer(nextBuffer);
      gl.deleteProgram(nextProgram);
      return false;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, nextBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    program = nextProgram;
    buffer = nextBuffer;
    position = nextPosition;
    timeLocation = nextTime;
    progressLocation = nextProgress;
    resolutionLocation = nextResolution;
    colorLocation = nextColor;
    return true;
  };

  const draw = (timestamp) => {
    if (contextLost || disposed) return;
    const profile = profiles[current];
    if (gl !== null && program !== null && timeLocation !== null && progressLocation !== null && resolutionLocation !== null && colorLocation !== null) {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(timeLocation, timestamp / 1000);
      gl.uniform1f(progressLocation, isAnimated() ? 1 : 0);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform3fv(colorLocation, palette[profile.mode]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }
    if (fallback === null) return;
    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const [red, green, blue] = palette[profile.mode].map((channel) => Math.round(channel * 255));
    fallback.clearRect(0, 0, width, height);
    fallback.strokeStyle = "rgba(" + red + "," + green + "," + blue + ",.72)";
    fallback.lineWidth = Math.max(1, width / 24);
    fallback.beginPath();
    fallback.moveTo(width * .12, centerY);
    fallback.bezierCurveTo(width * .3, centerY - height * .22, width * .42, centerY + height * .22, width * .58, centerY);
    fallback.bezierCurveTo(width * .72, centerY - height * .18, width * .82, centerY + height * .14, width * .9, centerY);
    fallback.stroke();
  };

  const tick = (time) => {
    frame = 0;
    if (!isAnimated()) return;
    if (burstFrames >= maxFrames || time - burstStartedAt >= burstDuration) return;
    if (time - lastFrame < frameInterval) {
      frame = window.requestAnimationFrame(tick);
      return;
    }
    lastFrame = time;
    draw(time);
    burstFrames += 1;
    frame = window.requestAnimationFrame(tick);
  };

  const start = () => {
    stop();
    burstStartedAt = performance.now();
    burstFrames = 0;
    lastFrame = 0;
    draw(burstStartedAt);
    if (isAnimated()) frame = window.requestAnimationFrame(tick);
  };

  const render = (status) => {
    current = profiles[status] === undefined ? "ready" : status;
    const profile = profiles[current];
    root.dataset.status = current;
    label.textContent = profile.label;
    root.style.setProperty("--accent", profile.accent);
    root.style.setProperty("--accent-secondary", profile.accentSecondary);
    root.classList.toggle("is-active", profile.animated);
    draw(performance.now());
    start();
  };

  const onVisibility = () => {
    visible = document.visibilityState !== "hidden";
    start();
  };
  const onMotion = () => start();
  const onContextLost = (event) => {
    event.preventDefault();
    contextLost = true;
    stop();
    root.classList.add("canvas-fallback");
  };
  const onContextRestored = () => {
    contextLost = !setupWebgl();
    root.classList.toggle("canvas-fallback", contextLost);
    start();
  };
  const dispose = () => {
    disposed = true;
    stop();
    if (gl !== null) {
      if (buffer !== null) gl.deleteBuffer(buffer);
      if (program !== null) gl.deleteProgram(program);
    }
    buffer = null;
    program = null;
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("beforeunload", dispose);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
    removeMotionListener();
    removeMotionListener = () => {};
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", dispose);
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  if (typeof reducedMotionQuery.addEventListener === "function") {
    reducedMotionQuery.addEventListener("change", onMotion);
    removeMotionListener = () => reducedMotionQuery.removeEventListener("change", onMotion);
  } else if (typeof reducedMotionQuery.addListener === "function") {
    reducedMotionQuery.addListener(onMotion);
    removeMotionListener = () => reducedMotionQuery.removeListener(onMotion);
  }
  if (gl !== null && !setupWebgl()) {
    contextLost = true;
    root.classList.add("canvas-fallback");
  }
  window.__jarvisOverlay = { setState: render, dispose };
  render("ready");
})();
</script>`;

export function desktopJarvisOverlayDataUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';connect-src 'none';img-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}body{display:grid;place-items:center;color:#f4f7f5;font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}main{--accent:#8db5ae;--accent-secondary:#7388d7;box-sizing:border-box;position:relative;width:100%;height:100%;padding:0 18px 0 7px;border:1px solid color-mix(in srgb,var(--accent) 44%,transparent);border-radius:18px;background:linear-gradient(110deg,rgba(14,20,21,.98),rgba(19,23,30,.95));display:flex;align-items:center;gap:7px;isolation:isolate;overflow:hidden;box-shadow:0 12px 36px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.1)}main:after{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(ellipse at 8% 50%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 32%),linear-gradient(90deg,transparent 25%,rgba(255,255,255,.025),transparent 78%)}.visual-fallback{position:absolute;left:10px;top:50%;z-index:0;width:68px;height:10px;transform:translateY(-50%) rotate(-4deg);border-top:2px solid var(--accent);border-radius:50%;opacity:0;filter:drop-shadow(0 0 5px var(--accent));pointer-events:none}.visual-fallback:after{content:"";position:absolute;inset:2px 7px auto;height:5px;border-top:1px solid var(--accent-secondary);border-radius:50%;transform:rotate(7deg)}canvas{position:relative;z-index:1;display:block;width:74px;height:70px;flex:0 0 74px}.copy{min-width:0;display:grid;gap:4px}.eyebrow{color:color-mix(in srgb,var(--accent) 78%,#fff);font-size:10px;letter-spacing:.14em;text-transform:uppercase}.label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f4f7f5}.signal{width:5px;height:5px;margin-left:auto;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}.canvas-fallback canvas{opacity:.38}.canvas-fallback .visual-fallback{opacity:.9}@media(prefers-reduced-motion:reduce){.signal{animation:none}}
</style></head><body><main data-status="ready"><span class="visual-fallback" aria-hidden="true"></span><canvas width="74" height="70" aria-hidden="true"></canvas><div class="copy"><span class="eyebrow">JARVIS</span><span class="label" data-label>Jarvis is ready</span></div><i class="signal" aria-hidden="true"></i></main>${overlayScript}</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function desktopJarvisOverlayStateScript(state: DesktopJarvisVoiceState): string {
  return `window.__jarvisOverlay?.setState(${JSON.stringify(state.status)})`;
}
