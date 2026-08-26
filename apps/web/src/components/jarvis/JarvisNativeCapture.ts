export type JarvisNativeCapturePhase = "idle" | "starting" | "capturing";

export interface JarvisNativeCaptureBridge {
  readonly startCapture: () => Promise<{ readonly accepted: boolean }>;
  readonly releaseCapture: () => Promise<{ readonly accepted: boolean }>;
  readonly cancelCapture: () => Promise<{ readonly accepted: boolean }>;
}

export type JarvisDesktopVoiceAction = "voice-toggle" | "voice-start" | "voice-release";

export function createJarvisNativeCaptureController(input: {
  readonly voice: JarvisNativeCaptureBridge;
  readonly onPhase: (phase: JarvisNativeCapturePhase) => void;
  readonly onStartFailure: () => void;
  readonly onReleaseFailure: () => void;
}): {
  readonly phase: () => JarvisNativeCapturePhase;
  readonly start: () => void;
  readonly release: () => void;
  readonly cancel: () => void;
  readonly markIdle: () => void;
  readonly markWorkerReady: () => void;
} {
  let phase: JarvisNativeCapturePhase = "idle";
  let pendingRelease = false;
  let generation = 0;

  const setPhase = (next: JarvisNativeCapturePhase): void => {
    phase = next;
    input.onPhase(next);
  };

  const release = (): void => {
    if (phase === "starting") {
      pendingRelease = true;
      return;
    }
    if (phase !== "capturing") return;
    pendingRelease = false;
    setPhase("idle");
    void input.voice.releaseCapture().then((result) => {
      if (!result.accepted) input.onReleaseFailure();
    }, input.onReleaseFailure);
  };

  const start = (): void => {
    if (phase !== "idle") return;
    pendingRelease = false;
    setPhase("starting");
    const requestGeneration = ++generation;
    void input.voice.startCapture().then(
      (result) => {
        if (requestGeneration !== generation) {
          if (result.accepted) void input.voice.cancelCapture().catch(() => undefined);
          return;
        }
        if (!result.accepted) {
          pendingRelease = false;
          setPhase("idle");
          input.onStartFailure();
          return;
        }
        setPhase("capturing");
        if (pendingRelease) {
          pendingRelease = false;
          release();
        }
      },
      () => {
        if (requestGeneration !== generation) return;
        pendingRelease = false;
        setPhase("idle");
        input.onStartFailure();
      },
    );
  };

  const cancel = (): void => {
    const wasActive = phase !== "idle";
    generation += 1;
    pendingRelease = false;
    setPhase("idle");
    if (wasActive) void input.voice.cancelCapture().catch(() => undefined);
  };

  return {
    phase: () => phase,
    start,
    release,
    cancel,
    markIdle: () => {
      generation += 1;
      pendingRelease = false;
      setPhase("idle");
    },
    markWorkerReady: () => {
      if (phase === "starting") return;
      generation += 1;
      pendingRelease = false;
      setPhase("idle");
    },
  };
}

/**
 * Owns the three desktop shortcut actions for one renderer lifetime. Keeping
 * the start/release phase here makes a fast key release deterministic even
 * when the native worker is still starting.
 */
export function createJarvisDesktopVoiceActionController(input: {
  readonly voice: JarvisNativeCaptureBridge;
  readonly onStartFailure: () => void;
  readonly onReleaseFailure: () => void;
}): {
  readonly handle: (action: JarvisDesktopVoiceAction) => void;
  readonly syncWorkerState: (status: "ready" | "capturing" | "error" | "unavailable") => void;
  readonly dispose: () => void;
} {
  const capture = createJarvisNativeCaptureController({
    ...input,
    onPhase: () => undefined,
  });

  return {
    handle: (action) => {
      if (action === "voice-toggle") {
        if (capture.phase() === "idle") capture.start();
        else capture.release();
        return;
      }
      if (action === "voice-start") capture.start();
      else capture.release();
    },
    syncWorkerState: (status) => {
      if (status === "ready") capture.markWorkerReady();
      if (status === "error" || status === "unavailable") capture.markIdle();
    },
    dispose: capture.cancel,
  };
}
