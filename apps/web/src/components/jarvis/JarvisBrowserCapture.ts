import { playJarvisBrowserReceiptCue } from "./JarvisBrowserReceiptCue";

export type JarvisBrowserCapturePhase = "idle" | "listening" | "unsupported";

export interface JarvisBrowserTranscriptEvent {
  readonly transcript: string;
  readonly captureId: string;
  readonly isFinal: boolean;
}

type SpeechRecognitionAlternative = { readonly transcript: string };
type SpeechRecognitionResult = {
  readonly isFinal: boolean;
  readonly [index: number]: SpeechRecognitionAlternative;
  readonly length: number;
};
type SpeechRecognitionResultList = {
  readonly [index: number]: SpeechRecognitionResult;
  readonly length: number;
};
type SpeechRecognitionEventLike = {
  readonly results: SpeechRecognitionResultList;
  readonly resultIndex: number;
};
type SpeechRecognitionErrorEventLike = { readonly error?: string };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getBrowserSpeechConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const candidate =
    (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor })
      .webkitSpeechRecognition;
  return candidate ?? null;
}

/** Explicit feature detection: browser speech is a cloud/browser capability. */
export function isJarvisBrowserSpeechSupported(): boolean {
  return getBrowserSpeechConstructor() !== null;
}

/**
 * Browser hold-to-talk adapter. Results buffer until the user explicitly
 * releases, then emit exactly once: a cancel after an early final result
 * dispatches nothing. Recognition may auto-end mid-hold (silence with
 * continuous=false); the session restarts under the same capture so held
 * speech keeps accumulating. Generation guards drop late results after
 * cancel or unmount. Never used as a silent fallback for failed native
 * capture and never mounted where native capture owns the mic.
 */
export function createJarvisBrowserCaptureController(input: {
  readonly onTranscript: (event: JarvisBrowserTranscriptEvent) => void;
  readonly onError?: (message: string) => void;
  readonly onPhase?: (phase: JarvisBrowserCapturePhase) => void;
  readonly lang?: string;
  /**
   * Immediate receipt cue fired once from an explicit release, before the
   * buffered transcript emits. Defaults to the local oscillator blip: never
   * TTS, never network. Cancel and dispose never fire it, and a missing
   * player still releases the capture. Injected in tests to prove ordering
   * without asserting real audio playback.
   */
  readonly playReceiptCue?: () => void;
}): {
  readonly phase: () => JarvisBrowserCapturePhase;
  readonly supported: boolean;
  readonly start: (captureId?: string) => boolean;
  readonly release: () => void;
  readonly cancel: () => void;
  readonly dispose: () => void;
} {
  const supported = isJarvisBrowserSpeechSupported();
  let phase: JarvisBrowserCapturePhase = supported ? "idle" : "unsupported";
  let recognition: SpeechRecognitionLike | null = null;
  let generation = 0;
  let activeCaptureId: string | null = null;
  let disposed = false;
  let counter = 0;
  // Hold state for the current generation. `held` is true between start and
  // an explicit release/cancel; `settled` goes true once this generation has
  // emitted, errored, or been dropped so stragglers cannot double-emit.
  let held = false;
  let settled = false;
  let buffer = "";
  const lang =
    input.lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US") ?? "en-US";

  const setPhase = (next: JarvisBrowserCapturePhase): void => {
    phase = next;
    input.onPhase?.(next);
  };

  const cleanupRecognition = (): void => {
    const current = recognition;
    recognition = null;
    if (current !== null) {
      current.onresult = null;
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- single-owner slot, see start
      current.onerror = null;
      current.onend = null;
      try {
        current.abort();
      } catch {
        // Aborting a finished session throws on some browsers; guards already moved on.
      }
    }
  };

  const beginSegment = (requestGeneration: number, captureId: string): boolean => {
    const Constructor = getBrowserSpeechConstructor();
    if (Constructor === null) return false;
    try {
      const session = new Constructor();
      recognition = session;
      session.lang = lang;
      session.interimResults = false;
      session.maxAlternatives = 1;
      session.continuous = false;
      session.onresult = (event: SpeechRecognitionEventLike) => {
        if (disposed || requestGeneration !== generation || settled) return;
        const result = event.results[event.results.length - 1];
        const alternative = result?.[0];
        const transcript = alternative?.transcript.trim() ?? "";
        if (transcript.length === 0 || result?.isFinal === false) return;
        buffer = buffer.length === 0 ? transcript : `${buffer} ${transcript}`;
      };
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- single-owner slot, see above
      session.onerror = (event: SpeechRecognitionErrorEventLike) => {
        if (disposed || requestGeneration !== generation || settled) return;
        settled = true;
        held = false;
        buffer = "";
        activeCaptureId = null;
        cleanupRecognition();
        setPhase("idle");
        input.onError?.(event.error ?? "recognition-failed");
      };
      session.onend = () => {
        if (disposed || requestGeneration !== generation || settled) return;
        if (held) {
          // Auto-end mid-hold: keep capturing under the same capture id.
          if (!beginSegment(requestGeneration, captureId)) {
            settled = true;
            held = false;
            buffer = "";
            activeCaptureId = null;
            cleanupRecognition();
            setPhase("idle");
            input.onError?.("recognition-failed");
          }
          return;
        }
        settled = true;
        const text = buffer.trim();
        const deliveredCaptureId = activeCaptureId ?? captureId;
        buffer = "";
        activeCaptureId = null;
        recognition = null;
        setPhase("idle");
        if (text.length > 0) {
          input.onTranscript({ transcript: text, captureId: deliveredCaptureId, isFinal: true });
          return;
        }
        // An empty hold is a failure, never silence: the receipt cue already
        // fired at release, so report instead of leaving the hold hanging.
        input.onError?.("No speech was detected.");
      };
      session.start();
      setPhase("listening");
      return true;
    } catch {
      return false;
    }
  };

  return {
    phase: () => phase,
    supported,
    start: (captureId?: string) => {
      if (disposed || !supported || phase === "listening") return false;
      if (getBrowserSpeechConstructor() === null) {
        setPhase("unsupported");
        return false;
      }
      const requestGeneration = ++generation;
      const nextCaptureId = captureId ?? `browser-${Date.now()}-${(counter += 1)}`;
      activeCaptureId = nextCaptureId;
      held = true;
      settled = false;
      buffer = "";
      if (!beginSegment(requestGeneration, nextCaptureId)) {
        if (requestGeneration === generation) {
          held = false;
          settled = true;
          activeCaptureId = null;
          buffer = "";
          cleanupRecognition();
          setPhase("idle");
        }
        input.onError?.("recognition-failed");
        return false;
      }
      return true;
    },
    release: () => {
      if (phase !== "listening" || !held) return;
      held = false;
      // Immediate receipt: local cue only, before the buffered final emits
      // from onend and before any provider dispatch. Never acceptance, never
      // gated on inference or TTS. Failures stay silent so the release lands.
      try {
        (input.playReceiptCue ?? playJarvisBrowserReceiptCue)();
      } catch {
        // A missing audio path must not block the release.
      }
      const session = recognition;
      if (session === null) return;
      // The buffered final emits once from onend.
      try {
        session.stop();
      } catch {
        // Stopping twice is benign; onend still settles the phase.
      }
    },
    cancel: () => {
      held = false;
      settled = true;
      buffer = "";
      generation += 1;
      activeCaptureId = null;
      cleanupRecognition();
      if (!disposed && phase !== "unsupported") setPhase("idle");
    },
    dispose: () => {
      disposed = true;
      held = false;
      settled = true;
      buffer = "";
      generation += 1;
      activeCaptureId = null;
      cleanupRecognition();
    },
  };
}
