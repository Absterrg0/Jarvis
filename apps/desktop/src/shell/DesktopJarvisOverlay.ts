import type { DesktopJarvisVoiceState, DesktopJarvisVoiceStatus } from "@t3tools/contracts";

export interface DesktopJarvisOverlayPresentation {
  readonly label: string;
  readonly accent: string;
  readonly accentSecondary: string;
  readonly animated: boolean;
  readonly settled: boolean;
}

interface DesktopJarvisOverlayProfile {
  readonly label: string;
  readonly accent: string;
  readonly accentSecondary: string;
  readonly animated: boolean;
}

const DESKTOP_JARVIS_OVERLAY_PROFILES: Readonly<
  Record<DesktopJarvisVoiceStatus, DesktopJarvisOverlayProfile>
> = {
  starting: {
    label: "Preparing Jarvis voice",
    accent: "#8dd8cf",
    accentSecondary: "#6b9bf2",
    animated: true,
  },
  capturing: {
    label: "Jarvis is listening",
    accent: "#71d6cd",
    accentSecondary: "#618df4",
    animated: true,
  },
  transcribing: {
    label: "Jarvis is understanding",
    accent: "#9ba9ff",
    accentSecondary: "#c18bed",
    animated: true,
  },
  speaking: {
    label: "Jarvis is speaking",
    accent: "#f3b778",
    accentSecondary: "#dd7dcb",
    animated: true,
  },
  error: {
    label: "Jarvis voice needs attention",
    accent: "#ff9c9c",
    accentSecondary: "#ec6e83",
    animated: false,
  },
  unavailable: {
    label: "Jarvis voice is unavailable",
    accent: "#ffb08d",
    accentSecondary: "#d97879",
    animated: false,
  },
  ready: {
    label: "Jarvis is ready",
    accent: "#8db5ae",
    accentSecondary: "#7388d7",
    animated: false,
  },
};

const serializedOverlayProfiles = JSON.stringify(DESKTOP_JARVIS_OVERLAY_PROFILES).replaceAll(
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

  const context = canvas.getContext("2d", { alpha: true });
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const profiles = ${serializedOverlayProfiles};
  let current = "ready";
  let visible = document.visibilityState !== "hidden";
  let frame = 0;
  let lastFrame = 0;
  let disposed = false;
  let contextLost = context === null;
  let removeMotionListener = () => {};
  if (contextLost) root.classList.add("canvas-fallback");

  const stop = () => {
    if (frame !== 0) window.cancelAnimationFrame(frame);
    frame = 0;
  };

  const isAnimated = () => profiles[current].animated && visible && !reducedMotionQuery.matches && !contextLost && !disposed;

  const draw = (time) => {
    if (context === null || contextLost || disposed) return;
    const profile = profiles[current];
    const width = canvas.width;
    const height = canvas.height;
    const centerX = 35;
    const centerY = height / 2;
    const phase = isAnimated() ? time / 1050 : 0;
    context.clearRect(0, 0, width, height);

    const glow = context.createRadialGradient(centerX, centerY, 1, centerX, centerY, 31);
    glow.addColorStop(0, profile.accent + "b8");
    glow.addColorStop(0.5, profile.accentSecondary + "66");
    glow.addColorStop(1, profile.accentSecondary + "00");
    context.fillStyle = glow;
    context.fillRect(0, 0, 74, height);

    context.save();
    context.globalCompositeOperation = "screen";
    for (let band = 0; band < 3; band += 1) {
      context.beginPath();
      for (let x = 8; x <= 63; x += 2) {
        const wave = Math.sin(x / 8 + phase * (1.35 + band * 0.18) + band * 1.7) * (2.5 + band * 0.9);
        const y = centerY + wave + (band - 1) * 4;
        if (x === 8) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.lineTo(63, height - 16);
      context.lineTo(8, height - 16);
      context.closePath();
      const ribbon = context.createLinearGradient(8, 12, 63, height - 12);
      ribbon.addColorStop(0, profile.accent + (band === 1 ? "c8" : "55"));
      ribbon.addColorStop(1, profile.accentSecondary + (band === 1 ? "85" : "22"));
      context.fillStyle = ribbon;
      context.fill();
    }
    context.restore();

    context.beginPath();
    context.arc(centerX, centerY, 11, 0, Math.PI * 2);
    context.fillStyle = profile.accent + "e6";
    context.shadowColor = profile.accent;
    context.shadowBlur = isAnimated() ? 14 + Math.sin(phase * 2) * 3 : 9;
    context.fill();
    context.shadowBlur = 0;
    context.beginPath();
    context.arc(centerX - 3, centerY - 3, 3, 0, Math.PI * 2);
    context.fillStyle = "rgba(255,255,255,.8)";
    context.fill();
  };

  const tick = (time) => {
    frame = 0;
    if (!isAnimated()) return;
    if (time - lastFrame < 32) {
      frame = window.requestAnimationFrame(tick);
      return;
    }
    lastFrame = time;
    draw(time);
    frame = window.requestAnimationFrame(tick);
  };

  const start = () => {
    stop();
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
    contextLost = false;
    root.classList.remove("canvas-fallback");
    draw(performance.now());
    start();
  };
  const dispose = () => {
    disposed = true;
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("beforeunload", dispose);
    canvas.removeEventListener("contextlost", onContextLost);
    canvas.removeEventListener("contextrestored", onContextRestored);
    removeMotionListener();
    removeMotionListener = () => {};
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", dispose);
  canvas.addEventListener("contextlost", onContextLost);
  canvas.addEventListener("contextrestored", onContextRestored);
  if (typeof reducedMotionQuery.addEventListener === "function") {
    reducedMotionQuery.addEventListener("change", onMotion);
    removeMotionListener = () => reducedMotionQuery.removeEventListener("change", onMotion);
  } else if (typeof reducedMotionQuery.addListener === "function") {
    reducedMotionQuery.addListener(onMotion);
    removeMotionListener = () => reducedMotionQuery.removeListener(onMotion);
  }
  window.__jarvisOverlay = { setState: render, dispose };
  render("ready");
})();
</script>`;

export function desktopJarvisOverlayDataUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';connect-src 'none';img-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}body{display:grid;place-items:center;color:#f4f7f5;font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}main{--accent:#8db5ae;--accent-secondary:#7388d7;box-sizing:border-box;position:relative;width:100%;height:100%;padding:0 18px 0 7px;border:1px solid color-mix(in srgb,var(--accent) 44%,transparent);border-radius:18px;background:linear-gradient(110deg,rgba(14,20,21,.98),rgba(19,23,30,.95));display:flex;align-items:center;gap:7px;isolation:isolate;overflow:hidden;box-shadow:0 12px 36px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.1)}main:after{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(ellipse at 8% 50%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 32%),linear-gradient(90deg,transparent 25%,rgba(255,255,255,.025),transparent 78%)}canvas{display:block;width:74px;height:70px;flex:0 0 74px}.copy{min-width:0;display:grid;gap:4px}.eyebrow{color:color-mix(in srgb,var(--accent) 78%,#fff);font-size:10px;letter-spacing:.14em;text-transform:uppercase}.label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f4f7f5}.signal{width:5px;height:5px;margin-left:auto;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}.canvas-fallback canvas{opacity:.38}.canvas-fallback:before{content:"";position:absolute;top:24px;left:23px;width:23px;height:23px;border-radius:50%;background:var(--accent);filter:blur(8px);opacity:.8}@media(prefers-reduced-motion:reduce){.signal{animation:none}}
</style></head><body><main data-status="ready"><canvas width="74" height="70" aria-hidden="true"></canvas><div class="copy"><span class="eyebrow">JARVIS</span><span class="label" data-label>Jarvis is ready</span></div><i class="signal" aria-hidden="true"></i></main>${overlayScript}</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function desktopJarvisOverlayStateScript(state: DesktopJarvisVoiceState): string {
  return `window.__jarvisOverlay?.setState(${JSON.stringify(state.status)})`;
}
