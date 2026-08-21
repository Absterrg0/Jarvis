export type KokoroWorker = {
  readonly synthesize: (text: string) => Promise<string>;
  readonly close: () => Promise<void>;
};

export type KokoroLifecycleState = "offloaded" | "warming" | "ready" | "synthesizing";

export type KokoroLifecycle = {
  readonly prewarm: () => Promise<void>;
  readonly synthesize: (text: string, signal?: AbortSignal) => Promise<string>;
  readonly interrupt: () => void;
  readonly dispose: () => Promise<void>;
  readonly state: () => KokoroLifecycleState;
};

export type KokoroLifecycleScheduler = (delayMs: number, task: () => void) => () => void;

/**
 * Kokoro is deliberately process-scoped: closing the worker is the one reliable
 * way to return ONNX model memory to the OS. Prewarm and synthesis share one
 * load, then a short idle window absorbs nearby reports before full offload.
 */
export function createKokoroLifecycle(options: {
  readonly startWorker: () => Promise<KokoroWorker>;
  readonly schedule: KokoroLifecycleScheduler;
  readonly idleMs: number;
}): KokoroLifecycle {
  let lifecycleState: KokoroLifecycleState = "offloaded";
  let generation = 0;
  let worker: KokoroWorker | undefined;
  let warming: Promise<KokoroWorker> | undefined;
  let cancelEviction: (() => void) | undefined;
  let activeReject: ((cause: Error) => void) | undefined;

  const closeWorker = async (expectedGeneration?: number) => {
    if (expectedGeneration !== undefined && expectedGeneration !== generation) return;
    cancelEviction?.();
    cancelEviction = undefined;
    generation += 1;
    const current = worker;
    worker = undefined;
    warming = undefined;
    lifecycleState = "offloaded";
    activeReject?.(new DOMException("Jarvis speech was interrupted.", "AbortError"));
    activeReject = undefined;
    await current?.close().catch(() => undefined);
  };

  const scheduleEviction = () => {
    cancelEviction?.();
    const expectedGeneration = generation;
    cancelEviction = options.schedule(options.idleMs, () => {
      void closeWorker(expectedGeneration);
    });
  };

  const prewarm = async () => {
    cancelEviction?.();
    cancelEviction = undefined;
    if (worker !== undefined) {
      lifecycleState = "ready";
      scheduleEviction();
      return;
    }
    if (warming !== undefined) {
      await warming;
      return;
    }
    lifecycleState = "warming";
    const expectedGeneration = generation;
    const pending = options.startWorker();
    warming = pending;
    try {
      const started = await pending;
      if (generation !== expectedGeneration) {
        await started.close().catch(() => undefined);
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
      }
      worker = started;
      lifecycleState = "ready";
      scheduleEviction();
    } catch (cause) {
      if (generation === expectedGeneration) lifecycleState = "offloaded";
      throw cause;
    } finally {
      if (warming === pending) warming = undefined;
    }
  };

  return {
    prewarm,
    async synthesize(text, signal) {
      if (signal?.aborted) {
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
      }
      await prewarm();
      if (signal?.aborted) {
        await closeWorker();
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
      }
      const current = worker;
      if (current === undefined) throw new Error("Kokoro did not finish warming.");
      cancelEviction?.();
      cancelEviction = undefined;
      lifecycleState = "synthesizing";
      const expectedGeneration = generation;
      let removeAbort: () => void = () => undefined;
      try {
        return await new Promise<string>((resolve, reject) => {
          activeReject = reject;
          const onAbort = () => {
            void closeWorker(expectedGeneration);
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal?.removeEventListener("abort", onAbort);
          void current.synthesize(text).then(resolve, reject);
        });
      } finally {
        removeAbort();
        activeReject = undefined;
        if (generation === expectedGeneration && worker === current) {
          lifecycleState = "ready";
          scheduleEviction();
        }
      }
    },
    interrupt() {
      void closeWorker();
    },
    dispose() {
      return closeWorker();
    },
    state() {
      return lifecycleState;
    },
  };
}
