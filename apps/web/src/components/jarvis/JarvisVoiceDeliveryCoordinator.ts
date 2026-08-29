import type { JarvisVoiceReport, JarvisVoiceReportBatch } from "@t3tools/contracts";

export type JarvisVoiceDeliveryWake =
  | "batch"
  | "speech-state"
  | "voice-ready"
  | "reconnect"
  | "explicit"
  | "cooldown";

export type JarvisVoiceDeliveryState =
  | "claiming"
  | "blocked"
  | "speaking"
  | "deferred"
  | "failed"
  | "releasing"
  | "played-local"
  | "confirming"
  | "settled";

export type JarvisVoiceDeliveryEvent = {
  readonly reportId: string;
  readonly sequence: number;
  readonly operationId: number;
  readonly state: JarvisVoiceDeliveryState;
  readonly reason?: string;
};

export type JarvisVoiceClaim = {
  readonly granted: boolean;
  readonly speechState?: "claimed" | "leased" | "already-spoken" | "missing" | "legacy" | undefined;
};

export type JarvisVoiceConfirmation = {
  readonly confirmed: boolean;
  readonly state: "confirmed" | "already-spoken" | "lease-lost" | "missing";
};

export type JarvisVoiceRelease = {
  readonly released: boolean;
  readonly state: "released" | "already-spoken" | "lease-lost" | "missing";
};

export type JarvisVoiceSpeechOutcome =
  | { readonly status: "played" }
  | { readonly status: "deferred"; readonly reason: string }
  | { readonly status: "failed"; readonly code: string };

export type JarvisVoiceCommandResult<A> =
  | { readonly status: "succeeded"; readonly value: A }
  | { readonly status: "failed" };

export interface JarvisVoiceDeliveryCoordinatorPorts {
  readonly deviceId: string;
  readonly deliveryNamespace: string;
  readonly isReportForDevice: (report: JarvisVoiceReport) => boolean;
  readonly priority: number;
  readonly claim: (input: {
    readonly reportId: string;
    readonly deviceId: string;
    readonly priority: number;
  }) => Promise<JarvisVoiceCommandResult<JarvisVoiceClaim>>;
  readonly speak: (
    report: JarvisVoiceReport,
    deliveryId: string,
  ) => Promise<JarvisVoiceSpeechOutcome>;
  readonly cancelSpeech?: (deliveryId: string) => void | Promise<void>;
  readonly confirm: (input: {
    readonly reportId: string;
    readonly deviceId: string;
  }) => Promise<JarvisVoiceCommandResult<JarvisVoiceConfirmation>>;
  readonly release: (input: {
    readonly reportId: string;
    readonly deviceId: string;
  }) => Promise<JarvisVoiceCommandResult<JarvisVoiceRelease>>;
  readonly acknowledge: (throughSequence: number) => Promise<JarvisVoiceCommandResult<unknown>>;
  readonly hasPlayedLocally: (reportId: string) => boolean;
  readonly rememberPlayedLocally: (reportId: string) => void;
  readonly onEvent?: (event: JarvisVoiceDeliveryEvent) => void;
  readonly setDegraded: (detail: string) => void;
  readonly clearDegraded: () => void;
}

export type JarvisVoiceDeliveryScheduler = (delayMs: number, task: () => void) => () => void;

export type JarvisVoiceDeliveryCoordinator = {
  readonly receiveBatch: (batch: JarvisVoiceReportBatch) => void;
  readonly wake: (reason: JarvisVoiceDeliveryWake) => void;
  readonly dispose: () => void;
};

type Resume = "deferred" | "failed" | "confirm";
type Entry = {
  readonly reportId: string;
  sequence: number;
  report: JarvisVoiceReport;
  operationId: number;
  state: JarvisVoiceDeliveryState | "pending";
  resume: Resume | undefined;
  inFlight: boolean;
  cooldownUsed: boolean;
  releaseCooldownUsed: boolean;
  confirmCooldownUsed: boolean;
  retryCancel: (() => void) | undefined;
  speechDeliveryId: string | undefined;
};

const COOLDOWN_MS = 5_000;
let coordinatorLifetimeSequence = 0;

function defaultScheduler(delayMs: number, task: () => void): () => void {
  const timer = globalThis.setTimeout(task, delayMs);
  return () => globalThis.clearTimeout(timer);
}

function fingerprint(batch: JarvisVoiceReportBatch): string {
  return JSON.stringify({
    through: batch.batchThrough,
    acknowledged: batch.acknowledgedThrough,
    deliveries: batch.deliveries.map(({ sequence, report }) => [sequence, report]),
    removed: batch.removedReportIds,
  });
}

export function createJarvisVoiceDeliveryCoordinator(
  ports: JarvisVoiceDeliveryCoordinatorPorts,
  options: {
    readonly schedule?: JarvisVoiceDeliveryScheduler;
    readonly deliveryLifetimeId?: string;
  } = {},
): JarvisVoiceDeliveryCoordinator {
  const deliveryNamespace = `${ports.deliveryNamespace}:${options.deliveryLifetimeId ?? ++coordinatorLifetimeSequence}`;
  const schedule = options.schedule ?? defaultScheduler;
  const entries = new Map<string, Entry>();
  const playedLocally = new Set<string>();
  let operationSequence = 0;
  let batchFingerprint: string | undefined;
  let lastTruncationFloor: number | undefined;
  let batchReceived = false;
  let latestBatchThrough = 0;
  let acknowledgedThrough = 0;
  let ackPendingThrough: number | undefined;
  let ackCooldownUsed = false;
  let ackBlocked = false;
  let ackRetryCancel: (() => void) | undefined;
  let confirmRetryWake = false;
  const cancelCooldowns = new Set<() => void>();
  const degradedReports = new Set<string>();
  let disposed = false;
  let processing = false;
  let queued = false;

  const current = (entry: Entry, operationId = entry.operationId): boolean =>
    !disposed && entries.get(entry.reportId) === entry && entry.operationId === operationId;

  const emit = (entry: Entry, state: JarvisVoiceDeliveryState, reason?: string): void => {
    entry.state = state;
    const degraded = state === "failed";
    if (degraded) {
      if (!degradedReports.has(entry.reportId)) {
        degradedReports.add(entry.reportId);
        try {
          ports.setDegraded(reason ?? state);
        } catch {
          // Presentation observers cannot affect delivery ownership.
        }
      }
    } else if (!degraded && degradedReports.delete(entry.reportId) && degradedReports.size === 0) {
      try {
        ports.clearDegraded();
      } catch {
        // Presentation observers cannot affect delivery ownership.
      }
    }
    try {
      ports.onEvent?.({
        reportId: entry.reportId,
        sequence: entry.sequence,
        operationId: entry.operationId,
        state,
        ...(reason === undefined ? {} : { reason }),
      });
    } catch {
      // Presentation observers cannot affect delivery ownership.
    }
  };

  const scheduleCooldown = (task: () => void): (() => void) => {
    let cancel: (() => void) | undefined;
    cancel = schedule(COOLDOWN_MS, () => {
      if (cancel !== undefined) cancelCooldowns.delete(cancel);
      task();
    });
    cancelCooldowns.add(cancel);
    return cancel;
  };

  const scheduleEntryCooldown = (entry: Entry, task: () => void): void => {
    if (entry.retryCancel !== undefined) return;
    let cancel: (() => void) | undefined;
    cancel = schedule(COOLDOWN_MS, () => {
      if (cancel !== undefined) cancelCooldowns.delete(cancel);
      if (entry.retryCancel === cancel) entry.retryCancel = undefined;
      task();
    });
    entry.retryCancel = cancel;
    cancelCooldowns.add(cancel);
  };

  const cancelEntryCooldown = (entry: Entry): void => {
    if (entry.retryCancel === undefined) return;
    entry.retryCancel();
    cancelCooldowns.delete(entry.retryCancel);
    entry.retryCancel = undefined;
  };

  const cancelEntrySpeech = (entry: Entry): void => {
    const deliveryId = entry.speechDeliveryId;
    if (deliveryId === undefined) return;
    entry.speechDeliveryId = undefined;
    try {
      void Promise.resolve(ports.cancelSpeech?.(deliveryId)).catch(() => undefined);
    } catch {
      // Targeted cancellation is best effort. Durable report state stays authoritative.
    }
  };

  const clearEntryDegraded = (entry: Entry): void => {
    if (!degradedReports.delete(entry.reportId) || degradedReports.size !== 0) return;
    try {
      ports.clearDegraded();
    } catch {
      // Presentation observers cannot affect delivery ownership.
    }
  };

  const bestEffortRelease = async (
    entry: Entry,
    operationId: number,
  ): Promise<JarvisVoiceRelease | undefined> => {
    let result: JarvisVoiceCommandResult<JarvisVoiceRelease>;
    try {
      result = await ports.release({ reportId: entry.reportId, deviceId: ports.deviceId });
    } catch {
      result = { status: "failed" };
    }
    if (!current(entry, operationId) || result.status === "failed") return undefined;
    return result.value;
  };

  let retryRelease: (entry: Entry) => void = () => undefined;

  const releaseClaim = async (entry: Entry, operationId: number, resume: Resume): Promise<void> => {
    if (!current(entry, operationId)) return;
    entry.resume = resume;
    emit(entry, "releasing", resume);
    const result = await bestEffortRelease(entry, operationId);
    if (!current(entry, operationId)) return;
    if (result === undefined) {
      entry.state = "releasing";
      if (!entry.releaseCooldownUsed) {
        entry.releaseCooldownUsed = true;
        scheduleEntryCooldown(entry, () => retryRelease(entry));
      }
      return;
    }
    if (result.state === "already-spoken" || result.state === "missing") {
      emit(entry, "settled", result.state);
      return;
    }
    if (result.state === "lease-lost") {
      emit(entry, "blocked", "lease-lost");
      return;
    }
    if (resume === "deferred") {
      emit(entry, "deferred", "speech-deferred");
      return;
    }
    emit(entry, "failed", "speech-failed");
    if (!entry.cooldownUsed) {
      entry.cooldownUsed = true;
      scheduleEntryCooldown(entry, () => wake("cooldown"));
    }
  };

  retryRelease = (entry) => {
    if (!current(entry) || entry.inFlight) return;
    cancelEntryCooldown(entry);
    entry.inFlight = true;
    const operationId = (entry.operationId = ++operationSequence);
    void releaseClaim(entry, operationId, entry.resume ?? "failed").finally(() => {
      if (current(entry, operationId)) entry.inFlight = false;
    });
  };

  const allSettled = (): boolean =>
    [...entries.values()].every((entry) => entry.state === "settled");

  const attemptAcknowledge = async (throughSequence: number): Promise<void> => {
    if (
      disposed ||
      !batchReceived ||
      throughSequence <= acknowledgedThrough ||
      !allSettled() ||
      ackBlocked
    )
      return;
    ackPendingThrough = throughSequence;
    let result: JarvisVoiceCommandResult<unknown>;
    try {
      result = await ports.acknowledge(throughSequence);
    } catch {
      result = { status: "failed" };
    }
    if (disposed || ackPendingThrough !== throughSequence) return;
    if (result.status === "succeeded") {
      acknowledgedThrough = throughSequence;
      ackPendingThrough = undefined;
      ackCooldownUsed = false;
      ackBlocked = false;
      for (const entry of entries.values()) {
        if (entry.state !== "settled" || entry.sequence > throughSequence) continue;
        cancelEntryCooldown(entry);
        clearEntryDegraded(entry);
        playedLocally.delete(entry.reportId);
        entries.delete(entry.reportId);
      }
      return;
    }
    if (!ackCooldownUsed) {
      ackCooldownUsed = true;
      ackRetryCancel = scheduleCooldown(() => {
        ackRetryCancel = undefined;
        wake("cooldown");
      });
    } else ackBlocked = true;
  };

  const confirmExisting = async (entry: Entry): Promise<void> => {
    if (!current(entry) || entry.inFlight) return;
    entry.inFlight = true;
    const operationId = (entry.operationId = ++operationSequence);
    try {
      emit(entry, "played-local");
      emit(entry, "confirming");
      let confirmation: JarvisVoiceCommandResult<JarvisVoiceConfirmation>;
      try {
        confirmation = await ports.confirm({ reportId: entry.reportId, deviceId: ports.deviceId });
      } catch {
        confirmation = { status: "failed" };
      }
      if (!current(entry, operationId)) return;
      if (confirmation.status === "failed") {
        entry.resume = "confirm";
        emit(entry, "failed", "confirm-failed");
        if (!entry.confirmCooldownUsed) {
          entry.confirmCooldownUsed = true;
          scheduleEntryCooldown(entry, () => wake("cooldown"));
        }
        return;
      }
      if (confirmation.value.state === "lease-lost") {
        entry.resume = undefined;
        emit(entry, "blocked", "lease-lost");
        return;
      }
      entry.resume = undefined;
      emit(entry, "settled", confirmation.value.state);
    } finally {
      entry.inFlight = false;
    }
  };

  const runEntry = async (entry: Entry, allowConfirmRetry: boolean): Promise<void> => {
    if (!current(entry) || entry.state === "settled" || entry.inFlight) return;
    if (
      entry.state === "deferred" ||
      entry.state === "blocked" ||
      entry.state === "releasing" ||
      (entry.state === "failed" && entry.resume === "failed")
    )
      return;
    if (entry.state === "failed" && entry.resume === "confirm" && allowConfirmRetry) {
      await confirmExisting(entry);
      return;
    }
    if (entry.state === "failed" && entry.resume === "confirm") return;
    if (entry.state === "failed") entry.state = "pending";
    entry.inFlight = true;
    const operationId = (entry.operationId = ++operationSequence);
    try {
      emit(entry, "claiming");
      let claimResult: JarvisVoiceCommandResult<JarvisVoiceClaim>;
      try {
        claimResult = await ports.claim({
          reportId: entry.reportId,
          deviceId: ports.deviceId,
          priority: ports.priority,
        });
      } catch {
        claimResult = { status: "failed" };
      }
      if (!current(entry, operationId)) return;
      if (claimResult.status === "failed") {
        emit(entry, "failed", "claim-failed");
        if (!entry.cooldownUsed) {
          entry.cooldownUsed = true;
          scheduleEntryCooldown(entry, () => wake("cooldown"));
        }
        return;
      }
      const claim = claimResult.value;
      if (claim.speechState === "missing" || claim.speechState === "already-spoken") {
        emit(entry, "settled", claim.speechState);
        return;
      }
      if (!claim.granted) {
        emit(entry, "blocked", claim.speechState ?? "leased");
        return;
      }
      let alreadyPlayed = playedLocally.has(entry.reportId);
      if (!alreadyPlayed) {
        try {
          alreadyPlayed = ports.hasPlayedLocally(entry.reportId);
        } catch {
          alreadyPlayed = false;
        }
      }
      if (!alreadyPlayed) {
        emit(entry, "speaking");
        let speech: JarvisVoiceSpeechOutcome;
        const deliveryId = `${deliveryNamespace}:${entry.reportId}:${operationId}`;
        entry.speechDeliveryId = deliveryId;
        try {
          speech = await ports.speak(entry.report, deliveryId);
        } catch {
          speech = { status: "failed", code: "speech-delivery-failed" };
        } finally {
          if (entry.speechDeliveryId === deliveryId) entry.speechDeliveryId = undefined;
        }
        if (!current(entry, operationId)) return;
        if (speech.status === "deferred") {
          await releaseClaim(entry, operationId, "deferred");
          return;
        }
        if (speech.status === "failed") {
          await releaseClaim(entry, operationId, "failed");
          return;
        }
        playedLocally.add(entry.reportId);
        try {
          ports.rememberPlayedLocally(entry.reportId);
        } catch {
          // In-memory playback state remains authoritative for this run.
        }
      }
      if (!current(entry, operationId)) return;
      emit(entry, "played-local");
      emit(entry, "confirming");
      let confirmation: JarvisVoiceCommandResult<JarvisVoiceConfirmation>;
      try {
        confirmation = await ports.confirm({ reportId: entry.reportId, deviceId: ports.deviceId });
      } catch {
        confirmation = { status: "failed" };
      }
      if (!current(entry, operationId)) return;
      if (confirmation.status === "failed") {
        entry.resume = "confirm";
        emit(entry, "failed", "confirm-failed");
        if (!entry.confirmCooldownUsed) {
          entry.confirmCooldownUsed = true;
          scheduleEntryCooldown(entry, () => wake("cooldown"));
        }
        return;
      }
      if (confirmation.value.state === "lease-lost") {
        entry.resume = undefined;
        emit(entry, "blocked", "lease-lost");
        return;
      }
      entry.resume = undefined;
      emit(entry, "settled", confirmation.value.state);
    } finally {
      entry.inFlight = false;
    }
  };

  const process = async (): Promise<void> => {
    if (processing || disposed) {
      queued = true;
      return;
    }
    processing = true;
    while (true) {
      queued = false;
      const allowConfirmRetry = confirmRetryWake;
      confirmRetryWake = false;
      for (const entry of entries.values()) {
        if (disposed) break;
        await runEntry(entry, allowConfirmRetry);
      }
      await attemptAcknowledge(latestBatchThrough);
      if (!queued || disposed) break;
    }
    processing = false;
  };

  const wake = (reason: JarvisVoiceDeliveryWake): void => {
    if (disposed) return;
    if (
      reason === "speech-state" ||
      reason === "voice-ready" ||
      reason === "reconnect" ||
      reason === "explicit"
    ) {
      for (const entry of entries.values()) {
        if (
          (reason === "voice-ready" || reason === "reconnect" || reason === "explicit") &&
          entry.state === "releasing" &&
          !entry.inFlight
        ) {
          retryRelease(entry);
        }
        if (entry.state === "blocked") entry.state = "pending";
        if (entry.state === "deferred" && reason !== "speech-state") {
          clearEntryDegraded(entry);
          entry.state = "pending";
        }
        if (entry.state === "failed" && reason !== "speech-state" && entry.resume !== "confirm") {
          clearEntryDegraded(entry);
          entry.state = "pending";
        }
        if (
          entry.state === "failed" &&
          entry.resume === "confirm" &&
          (reason === "reconnect" || reason === "explicit")
        ) {
          clearEntryDegraded(entry);
        }
        if (reason === "voice-ready" || reason === "reconnect" || reason === "explicit") {
          entry.cooldownUsed = false;
          entry.releaseCooldownUsed = false;
          entry.confirmCooldownUsed = false;
        }
      }
      if (reason === "reconnect" || reason === "explicit") {
        if (ackRetryCancel !== undefined) {
          ackRetryCancel();
          cancelCooldowns.delete(ackRetryCancel);
          ackRetryCancel = undefined;
        }
        ackCooldownUsed = false;
        ackBlocked = false;
        confirmRetryWake = true;
      }
    }
    if (reason === "cooldown") {
      confirmRetryWake = true;
      for (const entry of entries.values()) {
        if (entry.state === "releasing") {
          retryRelease(entry);
        } else if (entry.state === "failed" && entry.resume !== "confirm") {
          entry.state = "pending";
        }
      }
    }
    void process();
  };

  const receiveBatch = (batch: JarvisVoiceReportBatch): void => {
    if (disposed) return;
    batchReceived = true;
    if (batch.truncatedBefore !== undefined && batch.truncatedBefore !== lastTruncationFloor) {
      lastTruncationFloor = batch.truncatedBefore;
      if (ackRetryCancel !== undefined) {
        ackRetryCancel();
        cancelCooldowns.delete(ackRetryCancel);
        ackRetryCancel = undefined;
      }
      ackPendingThrough = undefined;
      ackCooldownUsed = false;
      ackBlocked = false;
      for (const entry of entries.values()) {
        cancelEntrySpeech(entry);
        cancelEntryCooldown(entry);
        clearEntryDegraded(entry);
      }
      entries.clear();
      playedLocally.clear();
    }
    latestBatchThrough = Math.max(latestBatchThrough, batch.batchThrough);
    const nextFingerprint = fingerprint(batch);
    const identical = batchFingerprint === nextFingerprint;
    batchFingerprint = nextFingerprint;
    const incoming = new Set<string>();
    const isDelta = batch.removedReportIds !== undefined;
    for (const delivery of batch.deliveries) {
      if (delivery.sequence <= acknowledgedThrough) continue;
      incoming.add(delivery.report.reportId);
      const existing = entries.get(delivery.report.reportId);
      if (existing === undefined) {
        entries.set(delivery.report.reportId, {
          reportId: delivery.report.reportId,
          sequence: delivery.sequence,
          report: delivery.report,
          operationId: ++operationSequence,
          state: ports.isReportForDevice(delivery.report) ? "pending" : "settled",
          resume: undefined,
          inFlight: false,
          cooldownUsed: false,
          releaseCooldownUsed: false,
          confirmCooldownUsed: false,
          retryCancel: undefined,
          speechDeliveryId: undefined,
        });
      } else if (
        (!identical && JSON.stringify(existing.report) !== JSON.stringify(delivery.report)) ||
        existing.sequence !== delivery.sequence
      ) {
        existing.sequence = delivery.sequence;
        existing.report = delivery.report;
        if (existing.inFlight) {
          cancelEntryCooldown(existing);
          clearEntryDegraded(existing);
          cancelEntrySpeech(existing);
          playedLocally.delete(delivery.report.reportId);
          entries.delete(delivery.report.reportId);
          entries.set(delivery.report.reportId, {
            reportId: delivery.report.reportId,
            sequence: delivery.sequence,
            report: delivery.report,
            operationId: ++operationSequence,
            state: ports.isReportForDevice(delivery.report) ? "pending" : "settled",
            resume: undefined,
            inFlight: false,
            cooldownUsed: false,
            releaseCooldownUsed: false,
            confirmCooldownUsed: false,
            retryCancel: undefined,
            speechDeliveryId: undefined,
          });
        } else {
          cancelEntryCooldown(existing);
          clearEntryDegraded(existing);
          playedLocally.delete(delivery.report.reportId);
          existing.operationId = ++operationSequence;
          existing.state = ports.isReportForDevice(delivery.report) ? "pending" : "settled";
          existing.resume = undefined;
        }
      }
    }
    for (const reportId of batch.removedReportIds ?? []) {
      playedLocally.delete(reportId);
      const entry = entries.get(reportId);
      if (entry !== undefined) {
        cancelEntryCooldown(entry);
        clearEntryDegraded(entry);
        cancelEntrySpeech(entry);
        entries.delete(reportId);
      }
    }
    if (!isDelta) {
      for (const [reportId, entry] of entries) {
        if (!incoming.has(reportId)) {
          cancelEntryCooldown(entry);
          clearEntryDegraded(entry);
          cancelEntrySpeech(entry);
          playedLocally.delete(reportId);
          entries.delete(reportId);
        }
      }
    }
    wake(identical ? "speech-state" : "batch");
  };

  return {
    receiveBatch,
    wake,
    dispose: () => {
      disposed = true;
      for (const cancel of cancelCooldowns) cancel();
      cancelCooldowns.clear();
      if (degradedReports.size !== 0) {
        degradedReports.clear();
        try {
          ports.clearDegraded();
        } catch {
          // Presentation observers cannot affect delivery ownership.
        }
      }
      for (const entry of entries.values()) cancelEntrySpeech(entry);
      entries.clear();
      playedLocally.clear();
    },
  };
}
