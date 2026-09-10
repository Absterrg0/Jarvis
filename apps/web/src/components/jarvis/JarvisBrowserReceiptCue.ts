type ReceiptAudioContextLike = {
  readonly state?: string;
  resume?: () => Promise<void> | void;
  createOscillator: () => {
    type: string;
    frequency: { value: number };
    connect: (node: unknown) => void;
    start: () => void;
    stop: () => void;
  };
  createGain: () => {
    gain: {
      value: number;
      setValueAtTime?: (value: number, time: number) => void;
      exponentialRampToValueAtTime?: (value: number, time: number) => void;
    };
    connect: (node: unknown) => void;
  };
  readonly destination?: unknown;
  readonly currentTime?: number;
  close?: () => Promise<void> | void;
};

type ReceiptAudioConstructorLike = new () => ReceiptAudioContextLike;

/**
 * Immediate capture receipt blip for browser hold-to-talk.
 *
 * Local oscillator only: never touches speechSynthesis, TTS, network, or
 * downloads, and never loops. Callers fire it synchronously from the release
 * gesture (pointer/key up) before the buffered transcript emits, so the cue
 * lands before ASR finalization and provider dispatch. Failures stay silent
 * so the transcript and its truthful UI receipt still land.
 */
export function playJarvisBrowserReceiptCue(input?: {
  readonly createContext?: () => ReceiptAudioContextLike | null;
}): void {
  try {
    const factory = input?.createContext ?? defaultReceiptContext;
    const context = factory();
    if (context === null) return;
    try {
      void context.resume?.();
    } catch {
      // A suspended context must not block the release.
    }
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    const now = typeof context.currentTime === "number" ? context.currentTime : 0;
    try {
      gain.gain.setValueAtTime?.(0.0001, now);
      gain.gain.exponentialRampToValueAtTime?.(0.12, now + 0.012);
      gain.gain.exponentialRampToValueAtTime?.(0.0001, now + 0.09);
    } catch {
      gain.gain.value = 0.12;
    }
    oscillator.connect(gain);
    if (context.destination !== undefined) gain.connect(context.destination);
    oscillator.start();
    oscillator.stop();
    try {
      void context.close?.();
    } catch {
      // Closing is best-effort; the blip already played.
    }
  } catch {
    // No audio is still a truthful release: the transcript path owns feedback.
  }
}

function defaultReceiptContext(): ReceiptAudioContextLike | null {
  if (typeof window === "undefined") return null;
  const candidate =
    (
      window as unknown as {
        AudioContext?: ReceiptAudioConstructorLike;
        webkitAudioContext?: ReceiptAudioConstructorLike;
      }
    ).AudioContext ??
    (window as unknown as { webkitAudioContext?: ReceiptAudioConstructorLike }).webkitAudioContext;
  if (candidate === undefined) return null;
  try {
    return new candidate();
  } catch {
    return null;
  }
}
