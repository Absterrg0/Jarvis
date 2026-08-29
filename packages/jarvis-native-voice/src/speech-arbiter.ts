type SpeechJob = {
  readonly lane: "ordered" | "latest-report";
  readonly usesSpeechModel: boolean;
  readonly ready?: Promise<void>;
  readonly perform: (signal: AbortSignal) => Promise<boolean>;
  readonly cancelPending: () => void;
  readonly resolve: (spoken: boolean) => void;
  readonly reject: (cause: unknown) => void;
};

export type SpeechReservation = {
  /** Makes the reserved item speak. Repeated calls return the same completion. */
  readonly commit: (text: string) => Promise<boolean>;
  /** Releases the reserved item without speaking. */
  readonly cancel: () => void;
};

export type SpeechArbiter = {
  /** Queues a report, replacing only an older report that has not started. */
  readonly enqueue: (text: string) => Promise<boolean>;
  /** Reserves an ordered acknowledgement before asynchronous dispatch begins. */
  readonly reserve: () => SpeechReservation;
  /** Runs non-TTS audio under the same FIFO and interruption ownership. */
  readonly performOrdered: (action: (signal: AbortSignal) => Promise<void>) => Promise<boolean>;
  /** Stops current playback and releases every pending caller. */
  readonly interrupt: () => void;
  readonly isActive: () => boolean;
};

/**
 * Serializes all native TTS. Acknowledgements stay FIFO; stale pending reports
 * collapse to the latest state so Jarvis never talks over itself or reads an
 * obsolete completion minutes later.
 */
export function createSpeechArbiter(
  speak: (text: string, signal: AbortSignal) => Promise<void>,
  onIdle?: () => void,
): SpeechArbiter {
  let active = false;
  let generation = 0;
  const pending: SpeechJob[] = [];
  let current: SpeechJob | undefined;
  let currentAbort: AbortController | undefined;
  let restoreListeningWhenIdle = false;

  const run = async (job: SpeechJob, runGeneration: number): Promise<void> => {
    const abort = new AbortController();
    current = job;
    currentAbort = abort;
    try {
      if (job.ready !== undefined) await job.ready;
      if (abort.signal.aborted) {
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
      }
      const completed = await job.perform(abort.signal);
      if (abort.signal.aborted) {
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
      }
      job.resolve(completed);
    } catch (cause) {
      if (abort.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) {
        job.resolve(false);
      } else {
        job.reject(cause);
      }
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

  const schedule = (job: SpeechJob): void => {
    if (job.usesSpeechModel) restoreListeningWhenIdle = true;
    if (!active) {
      active = true;
      void run(job, generation);
      return;
    }
    if (job.lane === "ordered") {
      const firstReport = pending.findIndex((candidate) => candidate.lane === "latest-report");
      if (firstReport < 0) pending.push(job);
      else pending.splice(firstReport, 0, job);
      return;
    }
    const staleReport = pending.findLastIndex((candidate) => candidate.lane === "latest-report");
    if (staleReport < 0) {
      pending.push(job);
      return;
    }
    const stale = pending[staleReport]!;
    stale.cancelPending();
    stale.resolve(false);
    pending[staleReport] = job;
  };

  return {
    enqueue(text) {
      return new Promise<boolean>((resolveSpeech, rejectSpeech) => {
        schedule({
          lane: "latest-report",
          usesSpeechModel: true,
          perform: async (signal) => {
            await speak(text, signal);
            return true;
          },
          cancelPending: () => undefined,
          resolve: (spoken) => resolveSpeech(spoken),
          reject: rejectSpeech,
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
      let resolveSpeech: (spoken: boolean) => void = () => undefined;
      let rejectSpeech: (cause: unknown) => void = () => undefined;
      const completion = new Promise<boolean>((resolve, reject) => {
        resolveSpeech = resolve;
        rejectSpeech = reject;
      });
      const cancelPending = () => {
        if (!waiting) return;
        waiting = false;
        release();
      };
      const job: SpeechJob = {
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
            resolveSpeech(false);
          }
        },
      };
    },
    performOrdered(action) {
      return new Promise<boolean>((resolveSpeech, rejectSpeech) => {
        schedule({
          lane: "ordered",
          usesSpeechModel: false,
          perform: async (signal) => {
            await action(signal);
            return true;
          },
          cancelPending: () => undefined,
          resolve: resolveSpeech,
          reject: rejectSpeech,
        });
      });
    },
    interrupt() {
      const wasActive = active;
      for (const job of pending.splice(0)) {
        job.cancelPending();
        job.resolve(false);
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
