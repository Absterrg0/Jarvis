import type { DesktopJarvisVoiceState, DesktopJarvisVoiceStatus } from "@t3tools/contracts";

export interface DesktopJarvisOverlayPresentation {
  readonly label: string;
  readonly accent: string;
  readonly accentSecondary: string;
  readonly animated: boolean;
  readonly settled: boolean;
}

export type DesktopJarvisOverlayInteraction = "hold" | "tap";

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
    label: "Warming local listening",
    accent: "#8dd8cf",
    accentSecondary: "#6b9bf2",
    animated: true,
  },
  capturing: {
    label: "Listening",
    accent: "#71d6cd",
    accentSecondary: "#618df4",
    animated: true,
  },
  transcribing: {
    label: "Understanding your request",
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
 * The overlay is a tiny local document. It has no framework, network, canvas,
 * or render loop: state changes update copy and CSS variables, while a few
 * transform-only bars provide listening feedback.
 */
export const desktopJarvisOverlayPresentation = (
  state: DesktopJarvisVoiceState,
  options?: { readonly interaction?: DesktopJarvisOverlayInteraction },
): DesktopJarvisOverlayPresentation => {
  const profile = DESKTOP_JARVIS_OVERLAY_PROFILES[state.status];
  const label =
    state.status === "capturing" && options?.interaction === "tap"
      ? "Listening — tap again to stop"
      : profile.label;
  return { ...profile, label, settled: !profile.animated };
};

const overlayScript = String.raw`<script>
(() => {
  const root = document.querySelector("main");
  const label = document.querySelector("[data-label]");
  const hint = document.querySelector("[data-hint]");
  const bars = Array.from(document.querySelectorAll(".waveform b"));
  if (!root || !label || !hint) return;

  const profiles = ${serializedOverlayProfiles};
  let current = "ready";
  let interaction = "hold";
  let levelHistory = [0, 0, 0, 0, 0, 0, 0];

  const hintFor = (status) => {
    if (status === "capturing") return interaction === "tap" ? "Tap again to send" : "Release to send";
    if (status === "starting") return "Opening microphone";
    if (status === "transcribing") return "Speak after the ready tone";
    if (status === "speaking") return "Playing response";
    if (status === "error" || status === "unavailable") return "Open Jarvis for details";
    return interaction === "tap" ? "Tap shortcut to talk" : "Hold shortcut to talk";
  };

  const replayEntrance = () => {
    root.classList.remove("entering");
    void root.offsetWidth;
    root.classList.add("entering");
  };

  const render = (status, nextInteraction) => {
    const previous = current;
    current = profiles[status] === undefined ? "ready" : status;
    if (nextInteraction === "tap" || nextInteraction === "hold") interaction = nextInteraction;
    const profile = profiles[current];
    root.dataset.status = current;
    label.textContent = current === "capturing" && interaction === "tap" ? "Listening" : profile.label;
    hint.textContent = hintFor(current);
    root.style.setProperty("--accent", profile.accent);
    root.style.setProperty("--accent-secondary", profile.accentSecondary);
    root.classList.toggle("is-active", profile.animated);
    if (profile.animated && !profiles[previous].animated) replayEntrance();
    if (!profile.animated) {
      levelHistory = [0, 0, 0, 0, 0, 0, 0];
      bars.forEach((bar) => {
        bar.style.transform = "scaleY(.2)";
      });
    }
  };

  const setLevel = (nextLevel) => {
    const level = Math.max(0, Math.min(1, Number(nextLevel) || 0));
    const visualLevel = level < 0.008 ? 0 : Math.min(1, Math.sqrt(level) * 2.2);
    levelHistory = [...levelHistory.slice(1), visualLevel];
    bars.forEach((bar, index) => {
      bar.style.transform = "scaleY(" + (0.2 + (levelHistory[index] ?? 0) * 0.8) + ")";
    });
  };

  window.__jarvisOverlay = { setState: render, setLevel };
  render("ready", "hold");
})();
</script>`;

export function desktopJarvisOverlayDataUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';connect-src 'none';img-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
body{color:#f5f7f6;font:500 13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{--accent:#8db5ae;--accent-secondary:#7388d7;box-sizing:border-box;position:absolute;inset:6px 0;height:56px;padding:0 16px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:linear-gradient(115deg,rgba(11,13,17,.97),rgba(18,21,27,.94));display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;overflow:hidden;box-shadow:0 14px 36px rgba(0,0,0,.42),inset 0 1px rgba(255,255,255,.06);backdrop-filter:blur(18px);transition:border-color 180ms ease,box-shadow 180ms ease}
main:before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(100deg,color-mix(in srgb,var(--accent) 11%,transparent),transparent 42%,color-mix(in srgb,var(--accent-secondary) 6%,transparent));opacity:.85}
.status{position:relative;z-index:1;width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 12%,transparent),0 0 14px color-mix(in srgb,var(--accent) 55%,transparent);transition:background 180ms ease,box-shadow 180ms ease}
.copy{position:relative;z-index:1;min-width:0;display:grid;gap:3px}.label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f5f7f6;font-size:13px;font-weight:620;letter-spacing:-.01em}.hint{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(238,242,240,.48);font-size:9px;font-weight:560;letter-spacing:.08em;text-transform:uppercase}
.waveform{position:relative;z-index:1;height:26px;display:flex;align-items:center;gap:3px;padding:0 2px;color:var(--accent)}
.waveform b{display:block;width:3px;height:20px;border-radius:999px;background:linear-gradient(to top,var(--accent-secondary),var(--accent));opacity:.58;transform:scaleY(.2);transform-origin:center;transition:opacity 180ms ease,transform 100ms ease}
.waveform b:nth-child(1),.waveform b:nth-child(7){height:10px}.waveform b:nth-child(2),.waveform b:nth-child(6){height:15px}.waveform b:nth-child(3),.waveform b:nth-child(5){height:21px}.waveform b:nth-child(4){height:25px}
main.is-active{border-color:color-mix(in srgb,var(--accent) 38%,rgba(255,255,255,.1));box-shadow:0 16px 42px rgba(0,0,0,.46),0 0 24px color-mix(in srgb,var(--accent) 10%,transparent),inset 0 1px rgba(255,255,255,.07)}
main.is-active .waveform b{opacity:.95}
main.entering{animation:dock-in 240ms cubic-bezier(.22,1,.36,1) both}
@keyframes dock-in{0%{opacity:0;transform:translateY(10px) scale(.96)}100%{opacity:1;transform:translateY(0) scale(1)}}
@media (prefers-reduced-motion: reduce){main,.waveform b{animation:none!important;transition:none!important}}
</style></head><body><main data-status="ready"><span class="status" aria-hidden="true"></span><span class="copy"><span class="label" data-label>Jarvis is ready</span><span class="hint" data-hint>Voice shortcut ready</span></span><span class="waveform" aria-hidden="true"><b></b><b></b><b></b><b></b><b></b><b></b><b></b></span></main>${overlayScript}</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function desktopJarvisOverlayStateScript(
  state: DesktopJarvisVoiceState,
  options?: { readonly interaction?: DesktopJarvisOverlayInteraction },
): string {
  const interaction = options?.interaction ?? "hold";
  return `window.__jarvisOverlay?.setState(${JSON.stringify(state.status)}, ${JSON.stringify(interaction)})`;
}

export function desktopJarvisOverlayLevelScript(level: number): string {
  return `window.__jarvisOverlay?.setLevel(${JSON.stringify(Math.max(0, Math.min(1, level)))})`;
}
