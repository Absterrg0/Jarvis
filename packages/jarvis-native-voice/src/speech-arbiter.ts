type SpeechQueueJob = {
  readonly deliveryId?: string;
  readonly usesSpeechModel: boolean;
  readonly ready?: Promise<void>;
  readonly perform: (signal: AbortSignal) => Promise<boolean>;
  readonly cancelPending: () => void;
  readonly resolve: (outcome: SpeechQueueOutcome) => void;
  readonly reject: (cause: unknown) => void;
};

export type SpeechQueueOutcome =
  | { readonly status: "played" }
  | {
      readonly status: "not-played";
      readonly reason: "interrupted" | "cancelled-before-start" | "not-played";
    };

export type SpeechQueue = {
  readonly enqueue: (text: string, deliveryId: string) => Promise<SpeechQueueOutcome>;
  readonly performOrdered: (
    action: (signal: AbortSignal) => Promise<void>,
  ) => Promise<SpeechQueueOutcome>;
  readonly cancel: (deliveryId: string) => void;
  readonly interrupt: () => void;
  readonly isActive: () => boolean;
};

export function createSpeechQueue(
  speak: (text: string, signal: AbortSignal, deliveryId?: string) => Promise<void>,
  onIdle?: () => void,
): SpeechQueue {
  let active = false;
  const pending: SpeechQueueJob[] = [];
  let current: SpeechQueueJob | undefined;
  let currentAbort: AbortController | undefined;
  let restoreListeningWhenIdle = false;

  const run = async (job: SpeechQueueJob): Promise<void> => {
    const abort = new AbortController();
    let started = false;
    current = job;
    currentAbort = abort;
    try {
      if (job.ready !== undefined) {
        // An interrupted pre-start wait must settle promptly: with the queue
        // held until the victim releases it, a never-settling ready would
        // otherwise stall the queue behind it.
        const aborted = new Promise<true>((resolve) => {
          if (abort.signal.aborted) resolve(true);
          else abort.signal.addEventListener("abort", () => resolve(true), { once: true });
        });
        const readySettled = await Promise.race([job.ready.then(() => false), aborted]);
        if (readySettled || abort.signal.aborted)
          throw new DOMException("ARIS speech was interrupted.", "AbortError");
      }
      if (abort.signal.aborted)
        throw new DOMException("ARIS speech was interrupted.", "AbortError");
      started = true;
      const completed = await job.perform(abort.signal);
      if (abort.signal.aborted)
        throw new DOMException("ARIS speech was interrupted.", "AbortError");
      job.resolve(
        completed ? { status: "played" } : { status: "not-played", reason: "not-played" },
      );
    } catch (cause) {
      if (abort.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) {
        job.resolve({
          status: "not-played",
          reason: started ? "interrupted" : "cancelled-before-start",
        });
      } else job.reject(cause);
    } finally {
      if (current === job) current = undefined;
      if (currentAbort === abort) currentAbort = undefined;
      // The queue is released only here, when the settling job lets go: work
      // enqueued while an interrupted job is still in flight waits in pending
      // instead of overlapping it.
      const next = pending.shift();
      if (next === undefined) {
        active = false;
        if (restoreListeningWhenIdle) {
          restoreListeningWhenIdle = false;
          onIdle?.();
        }
      } else void run(next);
    }
  };

  const schedule = (job: SpeechQueueJob): void => {
    if (job.usesSpeechModel) restoreListeningWhenIdle = true;
    if (!active) {
      active = true;
      void run(job);
      return;
    }
    pending.push(job);
  };

  return {
    enqueue(text, deliveryId) {
      return new Promise<SpeechQueueOutcome>((resolve, reject) => {
        schedule({
          deliveryId,
          usesSpeechModel: true,
          perform: async (signal) => {
            await speak(text, signal, deliveryId);
            return true;
          },
          cancelPending: () => undefined,
          resolve,
          reject,
        });
      });
    },
    performOrdered(action) {
      return new Promise<SpeechQueueOutcome>((resolve, reject) => {
        schedule({
          usesSpeechModel: false,
          perform: async (signal) => {
            await action(signal);
            return true;
          },
          cancelPending: () => undefined,
          resolve,
          reject,
        });
      });
    },
    cancel(deliveryId) {
      const index = pending.findIndex((job) => job.deliveryId === deliveryId);
      if (index >= 0) {
        const [job] = pending.splice(index, 1);
        job?.cancelPending();
        job?.resolve({ status: "not-played", reason: "cancelled-before-start" });
        return;
      }
      if (current?.deliveryId !== deliveryId) return;
      current.cancelPending();
      currentAbort?.abort();
    },
    interrupt() {
      for (const job of pending.splice(0)) {
        job.cancelPending();
        job.resolve({ status: "not-played", reason: "cancelled-before-start" });
      }
      const victim = current;
      current?.cancelPending();
      currentAbort?.abort();
      currentAbort = undefined;
      if (victim === undefined && active) {
        // Nothing in flight: release the queue and restore listening now.
        // Otherwise the victim's finally releases it when it settles, so
        // work enqueued during interruption waits instead of overlapping it.
        active = false;
        if (restoreListeningWhenIdle) {
          restoreListeningWhenIdle = false;
          onIdle?.();
        }
      }
    },
    isActive: () => active,
  };
}
