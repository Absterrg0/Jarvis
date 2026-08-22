export type CompanionPresentationSurface = "voice" | "setup";

/**
 * The main process owns lifecycle and IPC; this module owns the small visual
 * contract that makes the generated surface feel alive without repainting at
 * rest. Keeping it behind one function makes a future native/managed host
 * surface able to reuse the same state vocabulary.
 */
export function companionPresentationStyle(surface: CompanionPresentationSurface): string {
  if (surface !== "voice") return "";
  return `<style>
.voice-field{position:absolute;z-index:1;inset:0;width:100%;height:100%;pointer-events:none;opacity:.78;mix-blend-mode:screen}.voice-field[hidden]{display:none}.presence-orb{z-index:2}
body[data-presentation-state="idle"] .orb-current,body[data-presentation-state="idle"] .orb-caustic,body[data-presentation-state="idle"] .presence-halo,body[data-presentation-state="error"] .orb-current,body[data-presentation-state="error"] .orb-caustic{animation:none!important;will-change:auto}
body[data-presentation-state="listening"] .orb-current,body[data-presentation-state="listening"] .orb-caustic,body[data-presentation-state="listening"] .presence-halo,body[data-presentation-state="transcribing"] .orb-current,body[data-presentation-state="transcribing"] .orb-caustic,body[data-presentation-state="working"] .orb-current,body[data-presentation-state="working"] .orb-caustic,body[data-presentation-state="speaking"] .orb-current,body[data-presentation-state="speaking"] .orb-caustic{will-change:transform,opacity;animation:jarvis-flow 8s ease-in-out infinite alternate}
body[data-presentation-state="listening"] .presence-halo,body[data-presentation-state="transcribing"] .presence-halo,body[data-presentation-state="working"] .presence-halo,body[data-presentation-state="speaking"] .presence-halo{will-change:transform,opacity;animation:jarvis-breathe 3.8s ease-in-out infinite alternate}
@keyframes jarvis-flow{from{transform:translate3d(-4%,-2%,0) rotate(-9deg) scale(1.01);opacity:.42}to{transform:translate3d(4%,3%,0) rotate(10deg) scale(1.06);opacity:.72}}
@keyframes jarvis-breathe{from{transform:scale(.9);opacity:.34}to{transform:scale(1.08);opacity:.7}}
@media (prefers-reduced-motion:reduce){body[data-presentation-state] .orb-current,body[data-presentation-state] .orb-caustic,body[data-presentation-state] .presence-halo{animation:none!important;will-change:auto}}
</style>`;
}
