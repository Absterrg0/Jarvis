export type JarvisNativeCapturePhase = "idle" | "starting" | "capturing";

export interface JarvisNativeCaptureBridge {
  readonly startCapture: (input?: {
    readonly purpose?: "command" | "diagnostic";
    readonly captureId?: string;
  }) => Promise<{ readonly accepted: boolean }>;
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
  let finalizing = false;
  let pendingHold = false;
  let generation = 0;
  const cancellationSentFor = new Set<number>();

  const setPhase = (next: JarvisNativeCapturePhase): void => {
    phase = next;
    input.onPhase(next);
  };

  const release = (): void => {
    if (phase === "starting") {
      pendingRelease = true;
      return;
    }
    if (phase !== "capturing") {
      if (finalizing) pendingHold = false;
      return;
    }
    pendingRelease = false;
    finalizing = true;
    setPhase("idle");
    void input.voice.releaseCapture().then(
      (result) => {
        if (!result.accepted) {
          finalizing = false;
          pendingHold = false;
          input.onReleaseFailure();
        }
      },
      () => {
        finalizing = false;
        pendingHold = false;
        input.onReleaseFailure();
      },
    );
  };

  const start = (): void => {
    if (phase !== "idle") return;
    if (finalizing) {
      pendingHold = true;
      return;
    }
    pendingRelease = false;
    setPhase("starting");
    const requestGeneration = ++generation;
    void input.voice.startCapture({ purpose: "command" }).then(
      (result) => {
        if (requestGeneration !== generation) {
          const cancellationAlreadySent = cancellationSentFor.delete(requestGeneration);
          if (result.accepted && !cancellationAlreadySent) {
            void input.voice.cancelCapture().catch(() => undefined);
          }
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
        if (requestGeneration !== generation) {
          cancellationSentFor.delete(requestGeneration);
          return;
        }
        pendingRelease = false;
        setPhase("idle");
        input.onStartFailure();
      },
    );
  };

  const cancel = (): void => {
    const wasActive = phase !== "idle" || finalizing || pendingHold;
    const wasStarting = phase === "starting";
    const cancelledGeneration = generation;
    generation += 1;
    pendingRelease = false;
    finalizing = false;
    pendingHold = false;
    setPhase("idle");
    if (wasActive) {
      // A starting request may resolve after this cancellation and needs one
      // correlated cleanup. Once the worker has accepted the start, there is
      // no late start callback to guard and retaining the generation would
      // only grow this set for the lifetime of the controller.
      if (wasStarting) cancellationSentFor.add(cancelledGeneration);
      void input.voice.cancelCapture().catch(() => undefined);
    }
  };

  return {
    phase: () => phase,
    start,
    release,
    cancel,
    markIdle: () => {
      generation += 1;
      pendingRelease = false;
      finalizing = false;
      pendingHold = false;
      setPhase("idle");
    },
    markWorkerReady: () => {
      if (phase === "starting") return;
      if (finalizing) {
        finalizing = false;
        const shouldStart = pendingHold;
        pendingHold = false;
        if (shouldStart) {
          start();
          return;
        }
      }
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
