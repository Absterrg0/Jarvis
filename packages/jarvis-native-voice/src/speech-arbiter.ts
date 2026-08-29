type SpeechQueueJob = {
  readonly lane: "ordered" | "report";
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

export type SpeechReservation = {
  readonly commit: (text: string) => Promise<SpeechQueueOutcome>;
  readonly cancel: () => void;
};

export type SpeechQueue = {
  readonly enqueue: (text: string, deliveryId: string) => Promise<SpeechQueueOutcome>;
  readonly reserve: () => SpeechReservation;
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
  let generation = 0;
  const pending: SpeechQueueJob[] = [];
  let current: SpeechQueueJob | undefined;
  let currentAbort: AbortController | undefined;
  let restoreListeningWhenIdle = false;

  const run = async (job: SpeechQueueJob, runGeneration: number): Promise<void> => {
    const abort = new AbortController();
    let started = false;
    current = job;
    currentAbort = abort;
    try {
      if (job.ready !== undefined) await job.ready;
      if (abort.signal.aborted)
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
      started = true;
      const completed = await job.perform(abort.signal);
      if (abort.signal.aborted)
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
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
      if (generation === runGeneration) {
        const next = pending.shift();
        if (next === undefined) {
          active = false;
          if (restoreListeningWhenIdle) {
            restoreListeningWhenIdle = false;
            onIdle?.();
          }
        } else void run(next, runGeneration);
      }
    }
  };

  const schedule = (job: SpeechQueueJob): void => {
    if (job.usesSpeechModel) restoreListeningWhenIdle = true;
    if (!active) {
      active = true;
      void run(job, generation);
      return;
    }
    if (job.lane === "ordered") {
      const firstReport = pending.findIndex((candidate) => candidate.lane === "report");
      if (firstReport < 0) pending.push(job);
      else pending.splice(firstReport, 0, job);
      return;
    }
    pending.push(job);
  };

  return {
    enqueue(text, deliveryId) {
      return new Promise<SpeechQueueOutcome>((resolve, reject) => {
        schedule({
          lane: "report",
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
    reserve() {
      let waiting = true;
      let reservedText: string | undefined;
      let release: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      let resolveSpeech: (outcome: SpeechQueueOutcome) => void = () => undefined;
      let rejectSpeech: (cause: unknown) => void = () => undefined;
      const completion = new Promise<SpeechQueueOutcome>((resolve, reject) => {
        resolveSpeech = resolve;
        rejectSpeech = reject;
      });
      const cancelPending = () => {
        if (!waiting) return;
        waiting = false;
        release();
      };
      const job: SpeechQueueJob = {
        lane: "ordered",
        usesSpeechModel: true,
        ready,
        perform: async (signal) => {
          if (reservedText === undefined) return false;
          await speak(reservedText, signal);
          return true;
        },
        cancelPending,
        resolve: resolveSpeech,
        reject: rejectSpeech,
      };
      schedule(job);
      return {
        commit(text) {
          if (waiting) {
            reservedText = text;
            waiting = false;
            release();
          }
          return completion;
        },
        cancel() {
          if (!waiting) return;
          cancelPending();
          const index = pending.indexOf(job);
          if (index >= 0) {
            pending.splice(index, 1);
            resolveSpeech({ status: "not-played", reason: "cancelled-before-start" });
          }
        },
      };
    },
    performOrdered(action) {
      return new Promise<SpeechQueueOutcome>((resolve, reject) => {
        schedule({
          lane: "ordered",
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
      const wasActive = active;
      for (const job of pending.splice(0)) {
        job.cancelPending();
        job.resolve({ status: "not-played", reason: "cancelled-before-start" });
      }
      generation += 1;
      active = false;
      current?.cancelPending();
      currentAbort?.abort();
      currentAbort = undefined;
      if (wasActive && restoreListeningWhenIdle) {
        restoreListeningWhenIdle = false;
        onIdle?.();
      }
    },
    isActive: () => active,
  };
}
