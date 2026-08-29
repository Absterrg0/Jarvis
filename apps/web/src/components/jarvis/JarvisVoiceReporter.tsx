import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopJarvisVoiceSpeechOutcome,
  DesktopJarvisVoiceState,
  EnvironmentId,
  JarvisVoiceReport,
  JarvisVoiceReportBatch,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron, isJarvisCompanionRelay } from "../../env";
import { publishJarvisAttentionTarget } from "../../jarvisBus";
import { jarvisReporterIdentity } from "../../jarvisIdentity";
import {
  areJarvisVoiceReportsEnabled,
  isPreferredJarvisSpeaker,
  onJarvisPreferencesChanged,
} from "../../jarvisPreferences";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentConnectionState, useEnvironments } from "../../state/environments";
import { jarvisEnvironment } from "../../state/jarvis";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  companionReportStatus,
  canMountJarvisVoiceReporter,
  effectiveJarvisVoiceReportBatch,
  enqueueJarvisPresentation,
  foldJarvisVoicePresentation,
  isJarvisReportForIdentity,
  isJarvisVoiceReadyEdge,
  rememberBoundedReportId,
  retryJarvisDelivery,
  removedJarvisReportIds,
  speakerPriority,
  spokenReportText,
  truncationStatusIds,
} from "./JarvisVoiceReporter.logic";
import {
  createJarvisVoiceDeliveryCoordinator,
  type JarvisVoiceCommandResult,
  type JarvisVoiceDeliveryCoordinator,
} from "./JarvisVoiceDeliveryCoordinator";

const SEEN_REPORTS_KEY = "t3code:jarvis:spoken-reports:v1";
const MAX_SEEN_REPORTS = 100;
const SPEECH_RETRY_COOLDOWN_MS = 5_000;
function deviceId(): string {
  return jarvisReporterIdentity();
}

function readSeenReports(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_REPORTS_KEY) ?? "[]") as unknown;
    return new Set(
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function rememberReport(key: string): boolean {
  const seen = readSeenReports();
  if (seen.has(key)) return false;
  seen.add(key);
  localStorage.setItem(SEEN_REPORTS_KEY, JSON.stringify([...seen].slice(-MAX_SEEN_REPORTS)));
  return true;
}

export function speakReport(
  _environmentId: EnvironmentId,
  report: JarvisVoiceReport,
  deliveryId?: string,
): Promise<DesktopJarvisVoiceSpeechOutcome> {
  const text = spokenReportText(report);
  const speakFallback = (): Promise<DesktopJarvisVoiceSpeechOutcome> => {
    if (window.jarvisCompanion?.speak) {
      return window.jarvisCompanion.speak(text).then(
        () => ({ status: "played" }),
        () => ({ status: "failed", code: "companion-speech-failed" }),
      );
    }
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
        resolve({ status: "failed", code: "speech-unavailable" });
        return;
      }
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = navigator.language || "en-US";
        utterance.rate = 1.03;
        utterance.addEventListener("end", () => resolve({ status: "played" }), { once: true });
        utterance.addEventListener(
          "error",
          () => resolve({ status: "failed", code: "browser-speech-failed" }),
          { once: true },
        );
        window.speechSynthesis.speak(utterance);
      } catch {
        resolve({ status: "failed", code: "browser-speech-failed" });
      }
    });
  };
  try {
    if (window.desktopBridge?.jarvisVoice) {
      return window.desktopBridge.jarvisVoice.speak(text, "report", deliveryId).then(
        (outcome) => outcome,
        () => ({
          status: "failed",
          code: "desktop-speech-failed",
        }),
      );
    }
    return speakFallback().then(
      (outcome) => outcome,
      () => ({
        status: "failed",
        code: "speech-delivery-failed",
      }),
    );
  } catch {
    return Promise.resolve({ status: "failed", code: "speech-delivery-failed" });
  }
}

function commandResult<A>(result: {
  readonly _tag: string;
  readonly value?: A;
}): JarvisVoiceCommandResult<A> {
  return result._tag === "Success"
    ? { status: "succeeded", value: result.value as A }
    : { status: "failed" };
}

function surfaceJarvisVoiceDeliveryFailure(): void {
  const description = "Jarvis could not deliver this report. Reconnect or retry to speak it.";
  toastManager.add({
    type: "warning",
    title: "Jarvis voice delivery failed",
    description,
    timeout: 10_000,
  });
  void window.jarvisCompanion
    ?.taskStatus("warning", description, "recoverable-failure")
    .catch(() => undefined);
}

function waitForJarvisDelivery(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: number | undefined;
    const finish = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    if (signal.aborted) {
      finish();
      return;
    }
    timer = window.setTimeout(finish, 1_000);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function CoordinatorEnvironmentVoiceReporter({
  environmentId,
  protocolVersion,
  onRelayConnection,
}: {
  readonly environmentId: EnvironmentId;
  readonly protocolVersion: 1 | 2;
  readonly onRelayConnection: (environmentId: EnvironmentId, connected: boolean) => void;
}) {
  const connection = useEnvironmentConnectionState(environmentId);
  const claimSpeaker = useAtomCommand(jarvisEnvironment.claimSpeaker, {
    reportFailure: false,
    reportDefect: false,
  });
  const acknowledgeReport = useAtomCommand(jarvisEnvironment.acknowledgeReport, {
    reportFailure: false,
    reportDefect: false,
  });
  const confirmReportSpoken = useAtomCommand(jarvisEnvironment.confirmReportSpoken, {
    reportFailure: false,
    reportDefect: false,
  });
  const releaseReportSpeech = useAtomCommand(jarvisEnvironment.releaseReportSpeech, {
    reportFailure: false,
    reportDefect: false,
  });
  const reports = useRef(new Map<string, JarvisVoiceReport>());
  const surfacedDeliveryStates = useRef(new Map<string, string>());
  const surfacedReportStatuses = useRef(new Map<string, string>());
  const settledReportIds = useRef(new Set<string>());
  const lastTruncationFloor = useRef<number | undefined>(undefined);
  const previousVoiceStatus = useRef<DesktopJarvisVoiceState["status"] | undefined>(undefined);
  const previousConnected = useRef(connection.data?.phase === "connected");
  const identity = useMemo(deviceId, []);
  const coordinator = useMemo<JarvisVoiceDeliveryCoordinator>(() => {
    return createJarvisVoiceDeliveryCoordinator(
      {
        deviceId: identity,
        deliveryNamespace: `${environmentId}:${identity}`,
        isReportForDevice: (report) => isJarvisReportForIdentity(report, identity),
        priority: speakerPriority({
          preferred: isPreferredJarvisSpeaker(),
          mobile: /Android|iPhone|iPad/iu.test(navigator.userAgent),
          electron: isElectron,
          relay: isJarvisCompanionRelay,
        }),
        claim: async (input) => commandResult(await claimSpeaker({ environmentId, input })),
        speak: (report, deliveryId) => speakReport(environmentId, report, deliveryId),
        cancelSpeech: async (deliveryId) => {
          await window.desktopBridge?.jarvisVoice?.cancelSpeech(deliveryId);
        },
        confirm: async (input) =>
          commandResult(await confirmReportSpoken({ environmentId, input })),
        release: async (input) =>
          commandResult(await releaseReportSpeech({ environmentId, input })),
        acknowledge: async (throughSequence) =>
          commandResult(
            await acknowledgeReport({
              environmentId,
              input: { throughSequence, originInteractionId: jarvisReporterIdentity() },
            }),
          ),
        hasPlayedLocally: (reportId) => readSeenReports().has(`${environmentId}:${reportId}`),
        rememberPlayedLocally: (reportId) => rememberReport(`${environmentId}:${reportId}`),
        setDegraded: (detail) => {
          const statusKey = `degraded:${detail}`;
          if (surfacedDeliveryStates.current.get("__voice_delivery__") === statusKey) return;
          surfacedDeliveryStates.current.set("__voice_delivery__", statusKey);
          void window.jarvisCompanion
            ?.taskStatus("warning", detail, "recoverable-failure", {
              statusId: "jarvis-voice-delivery",
            })
            .catch(() => undefined);
        },
        clearDegraded: () => {
          if (!surfacedDeliveryStates.current.delete("__voice_delivery__")) return;
          void window.jarvisCompanion
            ?.finishTaskStatus?.("jarvis-voice-delivery")
            .catch(() => undefined);
        },
        onEvent: (event) => {
          const report = reports.current.get(event.reportId);
          if (report === undefined) return;
          if (event.state === "blocked" || event.state === "deferred" || event.state === "failed") {
            const statusKey = `${event.state}:${event.reason ?? ""}`;
            if (surfacedDeliveryStates.current.get(event.reportId) === statusKey) return;
            surfacedDeliveryStates.current.set(event.reportId, statusKey);
            void window.jarvisCompanion
              ?.taskStatus(
                event.state === "failed" ? "error" : "attention",
                event.reason ?? "Jarvis is waiting to deliver this report.",
                event.state === "failed" ? "recoverable-failure" : "attention",
                { statusId: event.reportId },
              )
              .catch(() => undefined);
          }
          if (event.state === "settled") {
            rememberBoundedReportId(settledReportIds.current, event.reportId);
            surfacedDeliveryStates.current.delete(event.reportId);
            reports.current.delete(event.reportId);
            if (report.kind === "completed") {
              surfacedReportStatuses.current.delete(event.reportId);
              void window.jarvisCompanion
                ?.finishTaskStatus?.(event.reportId)
                .catch(() => undefined);
            }
          }
        },
      },
      { deliveryLifetimeId: randomUUID() },
    );
  }, [
    acknowledgeReport,
    claimSpeaker,
    confirmReportSpoken,
    environmentId,
    identity,
    releaseReportSpeech,
  ]);

  useEffect(() => {
    const voice = window.desktopBridge?.jarvisVoice;
    if (voice === undefined) return;
    return voice.onState((state) => {
      if (isJarvisVoiceReadyEdge(previousVoiceStatus.current, state.status)) {
        coordinator.wake("voice-ready");
      }
      previousVoiceStatus.current = state.status;
    });
  }, [coordinator]);

  useEffect(() => {
    const connected = connection.data?.phase === "connected";
    if (connected && !previousConnected.current) coordinator.wake("reconnect");
    previousConnected.current = connected;
  }, [connection.data?.phase, coordinator]);

  useEffect(() => () => coordinator.dispose(), [coordinator]);

  useEffect(() => {
    onRelayConnection(environmentId, connection.data?.phase === "connected");
    return () => onRelayConnection(environmentId, false);
  }, [connection.data?.phase, environmentId, onRelayConnection]);

  const result = useAtomValue(
    jarvisEnvironment.reportInbox({
      environmentId,
      input: {
        originInteractionId: jarvisReporterIdentity(),
        ...(protocolVersion === 2 ? { protocolVersion: 2 } : {}),
      },
    }),
  );
  useEffect(() => {
    if (!AsyncResult.isSuccess(result)) return;
    const truncationFloor = result.value.truncatedBefore;
    if (truncationFloor !== undefined && truncationFloor !== lastTruncationFloor.current) {
      lastTruncationFloor.current = truncationFloor;
      for (const statusId of truncationStatusIds({
        reports: reports.current,
        surfacedReportStatuses: surfacedReportStatuses.current,
        surfacedDeliveryStates: surfacedDeliveryStates.current,
      })) {
        void window.jarvisCompanion
          ?.finishTaskStatus?.(
            statusId === "__voice_delivery__" ? "jarvis-voice-delivery" : statusId,
          )
          .catch(() => undefined);
      }
      surfacedDeliveryStates.current.clear();
      surfacedReportStatuses.current.clear();
      settledReportIds.current.clear();
      reports.current.clear();
      toastManager.add({
        type: "warning",
        title: "Some Jarvis reports expired",
        description: "Open task history to review work completed while this device was away.",
        timeout: 10_000,
      });
      void window.jarvisCompanion
        ?.taskStatus(
          "warning",
          "Some older Jarvis reports expired before this device reconnected. Open task history to review the full record.",
          "recoverable-failure",
        )
        .catch(() => undefined);
    }
    const effectiveBatch =
      protocolVersion === 2
        ? effectiveJarvisVoiceReportBatch(reports.current, {
            batch: result.value,
            environmentId,
          })
        : result.value;
    const folded = foldJarvisVoicePresentation(reports.current, {
      batch: effectiveBatch,
      identity,
      settledReportIds: settledReportIds.current,
    });
    const removedReportIds =
      result.value.removedReportIds === undefined
        ? removedJarvisReportIds(reports.current, folded.reports)
        : folded.removedReportIds;
    for (const reportId of removedReportIds) {
      settledReportIds.current.delete(reportId);
      surfacedDeliveryStates.current.delete(reportId);
      surfacedReportStatuses.current.delete(reportId);
      void window.jarvisCompanion?.finishTaskStatus?.(reportId).catch(() => undefined);
    }
    reports.current = folded.reports;
    for (const delivery of folded.deliveries) {
      const report = delivery.report;
      publishJarvisAttentionTarget({
        environmentId: report.taskRef?.executionNodeId ?? environmentId,
        projectId: report.taskRef?.projectId ?? report.projectId,
        threadId: report.threadId,
        threadTitle: report.threadTitle,
        ...(report.taskRef === undefined ? {} : { taskRef: report.taskRef }),
      });
      const status = companionReportStatus(report);
      if (report.kind !== "work-started") {
        void window.jarvisCompanion
          ?.setAttentionTarget({
            projectId: report.projectId,
            threadId: report.threadId,
            reportKind: report.kind,
          })
          .catch(() => undefined);
      }
      const statusKey = `${status.state}:${status.detail}:${status.kind}`;
      if (surfacedReportStatuses.current.get(report.reportId) !== statusKey) {
        surfacedReportStatuses.current.set(report.reportId, statusKey);
        void window.jarvisCompanion
          ?.taskStatus(status.state, status.detail, status.kind, {
            stream: report.kind === "completed",
            statusId: report.reportId,
          })
          .catch(() => undefined);
      }
    }
    coordinator.receiveBatch(effectiveBatch);
  }, [coordinator, environmentId, identity, protocolVersion, result]);

  return null;
}

function EnvironmentVoiceReporterBody({
  environmentId,
  durableInbox,
  batch,
  onRelayConnection,
}: {
  readonly environmentId: EnvironmentId;
  readonly durableInbox: boolean;
  readonly batch: JarvisVoiceReportBatch | null;
  readonly onRelayConnection: (environmentId: EnvironmentId, connected: boolean) => void;
}) {
  const connection = useEnvironmentConnectionState(environmentId);
  const claimSpeaker = useAtomCommand(jarvisEnvironment.claimSpeaker, {
    reportFailure: false,
    reportDefect: false,
  });
  const acknowledgeReport = useAtomCommand(jarvisEnvironment.acknowledgeReport, {
    reportFailure: false,
    reportDefect: false,
  });
  const confirmReportSpoken = useAtomCommand(jarvisEnvironment.confirmReportSpoken, {
    reportFailure: false,
    reportDefect: false,
  });
  const releaseReportSpeech = useAtomCommand(jarvisEnvironment.releaseReportSpeech, {
    reportFailure: false,
    reportDefect: false,
  });
  const presentationQueue = useRef(Promise.resolve());
  const presented = useRef(new Set<string>());
  const currentDeliverySequences = useRef<ReadonlySet<number>>(new Set());
  const active = useRef(true);
  const speechRetry = useRef(new Map<string, number | "deferred">());
  const speechRetryTimers = useRef(new Map<string, number>());
  const [speechRetryRevision, setSpeechRetryRevision] = useState(0);
  const connected = connection.data?.phase === "connected";
  const connectedRef = useRef(connected);
  const wasConnectedRef = useRef(connected);
  connectedRef.current = connected;
  const deliveryActive = () => active.current && connectedRef.current;

  const clearSpeechRetry = useCallback(() => {
    if (speechRetry.current.size === 0 && speechRetryTimers.current.size === 0) return;
    for (const timer of speechRetryTimers.current.values()) window.clearTimeout(timer);
    speechRetryTimers.current.clear();
    speechRetry.current.clear();
    setSpeechRetryRevision((revision) => revision + 1);
  }, []);

  const scheduleSpeechRetry = useCallback((retryKey: string) => {
    const existingTimer = speechRetryTimers.current.get(retryKey);
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    speechRetry.current.set(retryKey, Date.now() + SPEECH_RETRY_COOLDOWN_MS);
    const timer = window.setTimeout(() => {
      speechRetryTimers.current.delete(retryKey);
      speechRetry.current.delete(retryKey);
      setSpeechRetryRevision((revision) => revision + 1);
    }, SPEECH_RETRY_COOLDOWN_MS);
    speechRetryTimers.current.set(retryKey, timer);
  }, []);

  const deferSpeechRetry = useCallback((retryKey: string) => {
    const existingTimer = speechRetryTimers.current.get(retryKey);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      speechRetryTimers.current.delete(retryKey);
    }
    speechRetry.current.set(retryKey, "deferred");
  }, []);

  useEffect(() => {
    if (connected && !wasConnectedRef.current) clearSpeechRetry();
    wasConnectedRef.current = connected;
  }, [clearSpeechRetry, connected]);

  useEffect(() => {
    const voice = window.desktopBridge?.jarvisVoice;
    if (voice === undefined) return;
    return voice.onState((state) => {
      if (state.status === "ready") clearSpeechRetry();
    });
  }, [clearSpeechRetry]);

  useEffect(
    () => () => {
      for (const timer of speechRetryTimers.current.values()) window.clearTimeout(timer);
      speechRetryTimers.current.clear();
    },
    [],
  );

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (batch === null) return;
    const deliverySequences = new Set(batch.deliveries.map((delivery) => delivery.sequence));
    if (durableInbox) currentDeliverySequences.current = deliverySequences;
    presentationQueue.current = enqueueJarvisPresentation(presentationQueue.current, async () => {
      if (!active.current) return;
      if (batch.truncatedBefore !== undefined) {
        const truncationKey = `truncated:${batch.truncatedBefore}`;
        if (!presented.current.has(truncationKey)) {
          if (!active.current) return;
          toastManager.add({
            type: "warning",
            title: "Some Jarvis reports expired",
            description: "Open task history to review work completed while this device was away.",
            timeout: 10_000,
          });
          await window.jarvisCompanion
            ?.taskStatus(
              "warning",
              "Some older Jarvis reports expired before this device reconnected. Open task history to review the full record.",
              "recoverable-failure",
            )
            .catch(() => undefined);
          presented.current.add(truncationKey);
        }
      }
      try {
        let presentationPending = false;
        let deliveryFailureSurfaced = false;
        const markDeliveryRetryable = () => {
          presentationPending = true;
          if (deliveryFailureSurfaced) return;
          deliveryFailureSurfaced = true;
          surfaceJarvisVoiceDeliveryFailure();
        };
        for (const delivery of batch.deliveries) {
          if (!active.current) return;
          if (durableInbox && !currentDeliverySequences.current.has(delivery.sequence)) {
            continue;
          }
          const report = delivery.report;
          const retryKey = `${environmentId}:${report.reportId}`;
          const retryAfter = speechRetry.current.get(retryKey);
          if (
            retryAfter === "deferred" ||
            (typeof retryAfter === "number" && retryAfter > Date.now())
          ) {
            presentationPending = true;
            continue;
          }
          speechRetry.current.delete(retryKey);
          const retryTimer = speechRetryTimers.current.get(retryKey);
          if (retryTimer !== undefined) {
            window.clearTimeout(retryTimer);
            speechRetryTimers.current.delete(retryKey);
          }
          const presentationKey = durableInbox ? String(delivery.sequence) : report.reportId;
          if (presented.current.has(presentationKey)) continue;
          if (!isJarvisReportForIdentity(report, deviceId())) {
            // This report belongs to another Companion/browser identity. Mark
            // it presented locally and let the batch acknowledgement advance
            // this inbox without stealing its speaker lease.
            presented.current.add(presentationKey);
            continue;
          }
          if (!active.current) return;
          const taskNodeId = report.taskRef?.executionNodeId ?? environmentId;
          const taskProjectId = report.taskRef?.projectId ?? report.projectId;
          publishJarvisAttentionTarget({
            environmentId: taskNodeId,
            projectId: taskProjectId,
            threadId: report.threadId,
            threadTitle: report.threadTitle,
            ...(report.taskRef === undefined ? {} : { taskRef: report.taskRef }),
          });
          const status = companionReportStatus(report);
          if (report.kind !== "work-started") {
            await window.jarvisCompanion
              ?.setAttentionTarget({
                projectId: report.projectId,
                threadId: report.threadId,
                reportKind: report.kind,
              })
              .catch(() => undefined);
          }
          await window.jarvisCompanion
            ?.taskStatus(status.state, status.detail, status.kind, {
              stream: report.kind === "completed",
              statusId: report.reportId,
            })
            .catch(() => undefined);
          try {
            if (!active.current) return;
            const claimResult = await claimSpeaker({
              environmentId,
              input: {
                reportId: report.reportId,
                deviceId: deviceId(),
                priority: speakerPriority({
                  preferred: isPreferredJarvisSpeaker(),
                  mobile: /Android|iPhone|iPad/iu.test(navigator.userAgent),
                  electron: isElectron,
                  relay: isJarvisCompanionRelay,
                }),
              },
            });
            if (claimResult._tag === "Failure") {
              scheduleSpeechRetry(retryKey);
              markDeliveryRetryable();
              continue;
            }
            const claim = claimResult.value;
            if (durableInbox && claim.speechState === "missing") {
              presented.current.add(presentationKey);
              continue;
            }
            if (!claim.granted) {
              // A competing speaker owns the report for now. Keep it pending
              // and let the next inbox wake, reconnect, or explicit retry
              // observe the durable state again.
              presentationPending = true;
              continue;
            }
            if (
              claim.granted &&
              (!durableInbox || currentDeliverySequences.current.has(delivery.sequence))
            ) {
              const reportKey = `${environmentId}:${report.reportId}`;
              let spoken = durableInbox && readSeenReports().has(reportKey);
              if (!active.current) return;
              if (!spoken) {
                if (window.desktopBridge?.jarvisVoice) {
                  void window.desktopBridge.jarvisVoice.prepareSpeech().catch(() => undefined);
                } else {
                  void window.jarvisCompanion?.prepareSpeech?.().catch(() => undefined);
                }
              }
              if (!active.current) return;
              let speechOutcome: DesktopJarvisVoiceSpeechOutcome = { status: "played" };
              if (!spoken) {
                speechOutcome = await speakReport(environmentId, report);
                spoken = speechOutcome.status === "played";
              }
              if (!spoken && speechOutcome.status === "deferred") {
                deferSpeechRetry(retryKey);
                await releaseReportSpeech({
                  environmentId,
                  input: { reportId: report.reportId, deviceId: deviceId() },
                }).catch(() => undefined);
                presentationPending = true;
                continue;
              }
              if (!spoken && speechOutcome.status === "failed") {
                scheduleSpeechRetry(retryKey);
                await releaseReportSpeech({
                  environmentId,
                  input: { reportId: report.reportId, deviceId: deviceId() },
                }).catch(() => undefined);
                markDeliveryRetryable();
                continue;
              }
              if (!spoken) {
                markDeliveryRetryable();
                continue;
              }
              if (durableInbox) rememberReport(reportKey);
              if (durableInbox && claim.speechState === "claimed") {
                const confirmation = await retryJarvisDelivery({
                  run: async () => {
                    const result = await confirmReportSpoken({
                      environmentId,
                      input: { reportId: report.reportId, deviceId: deviceId() },
                    });
                    return result._tag === "Success" ? result : { _tag: "Failure" };
                  },
                  isActive: deliveryActive,
                  wait: waitForJarvisDelivery,
                });
                if (confirmation.status === "cancelled") return;
                if (confirmation.status === "exhausted") {
                  markDeliveryRetryable();
                  continue;
                }
                // A lost lease means another speaker completed this report. It
                // does not clear a retryable failure from an earlier report in
                // the same acknowledgement batch.
              }
            }
          } catch {
            markDeliveryRetryable();
            continue;
          } finally {
            if (report.kind === "completed") {
              await window.jarvisCompanion
                ?.finishTaskStatus?.(report.reportId)
                .catch(() => undefined);
            }
          }
          presented.current.add(presentationKey);
        }
        if (durableInbox && !presentationPending) {
          const acknowledgement = await retryJarvisDelivery({
            run: () =>
              acknowledgeReport({
                environmentId,
                input: {
                  throughSequence: batch.batchThrough,
                  originInteractionId: jarvisReporterIdentity(),
                },
              }),
            isActive: deliveryActive,
            wait: waitForJarvisDelivery,
          });
          if (acknowledgement.status === "cancelled") return;
          if (acknowledgement.status === "exhausted") {
            surfaceJarvisVoiceDeliveryFailure();
            return;
          }
          if (presented.current.size > 1_024) {
            presented.current = new Set([...presented.current].slice(-512));
          }
        }
      } catch {
        // A reconnect re-runs acknowledgement while presented sequences stay suppressed.
      }
    });
  }, [
    acknowledgeReport,
    batch,
    claimSpeaker,
    confirmReportSpoken,
    connection.data?.phase,
    connected,
    durableInbox,
    environmentId,
    releaseReportSpeech,
    deferSpeechRetry,
    scheduleSpeechRetry,
    speechRetryRevision,
  ]);

  useEffect(() => {
    onRelayConnection(environmentId, connection.data?.phase === "connected");
    return () => onRelayConnection(environmentId, false);
  }, [connection.data?.phase, environmentId, onRelayConnection]);

  return null;
}

function DurableEnvironmentVoiceReporter({
  environmentId,
  protocolVersion,
  onRelayConnection,
}: {
  readonly environmentId: EnvironmentId;
  readonly protocolVersion: 1 | 2;
  readonly onRelayConnection: (environmentId: EnvironmentId, connected: boolean) => void;
}) {
  return (
    <CoordinatorEnvironmentVoiceReporter
      environmentId={environmentId}
      protocolVersion={protocolVersion}
      onRelayConnection={onRelayConnection}
    />
  );
}

function LegacyEnvironmentVoiceReporter({
  environmentId,
  onRelayConnection,
}: {
  readonly environmentId: EnvironmentId;
  readonly onRelayConnection: (environmentId: EnvironmentId, connected: boolean) => void;
}) {
  const result = useAtomValue(jarvisEnvironment.reports({ environmentId, input: {} }));
  const batch: JarvisVoiceReportBatch | null = useMemo(
    () =>
      AsyncResult.isSuccess(result)
        ? {
            acknowledgedThrough: 0,
            batchThrough: 0,
            deliveries: [{ sequence: 0, report: result.value }],
            hasMore: false,
          }
        : null,
    [result],
  );
  return (
    <EnvironmentVoiceReporterBody
      environmentId={environmentId}
      durableInbox={false}
      batch={batch}
      onRelayConnection={onRelayConnection}
    />
  );
}

function EnvironmentVoiceReporter({
  environmentId,
  durableInbox,
  protocolVersion,
  onRelayConnection,
}: {
  readonly environmentId: EnvironmentId;
  readonly durableInbox: boolean;
  readonly protocolVersion: 1 | 2;
  readonly onRelayConnection: (environmentId: EnvironmentId, connected: boolean) => void;
}) {
  const sessionState = useEnvironmentSessionState(environmentId);
  if (!canMountJarvisVoiceReporter(sessionState.data)) return null;
  return durableInbox ? (
    <DurableEnvironmentVoiceReporter
      environmentId={environmentId}
      protocolVersion={protocolVersion}
      onRelayConnection={onRelayConnection}
    />
  ) : (
    <LegacyEnvironmentVoiceReporter
      environmentId={environmentId}
      onRelayConnection={onRelayConnection}
    />
  );
}

/** Event-driven voice reports: no polling, microphone, or resident speech model. */
export function JarvisVoiceReporter() {
  const { environments } = useEnvironments();
  const [enabled, setEnabled] = useState(areJarvisVoiceReportsEnabled);
  const [connectedEnvironmentIds, setConnectedEnvironmentIds] = useState<
    ReadonlySet<EnvironmentId>
  >(() => new Set());

  const onRelayConnection = useCallback((environmentId: EnvironmentId, connected: boolean) => {
    setConnectedEnvironmentIds((current) => {
      const next = new Set(current);
      if (connected) next.add(environmentId);
      else next.delete(environmentId);
      return next;
    });
  }, []);

  useEffect(() => onJarvisPreferencesChanged(() => setEnabled(areJarvisVoiceReportsEnabled())), []);
  useEffect(() => {
    void window.jarvisCompanion?.reportRelayStatus?.(connectedEnvironmentIds.size > 0);
  }, [connectedEnvironmentIds]);
  if (
    !enabled ||
    typeof window === "undefined" ||
    (window.desktopBridge?.jarvisVoice === undefined &&
      window.jarvisCompanion?.speak === undefined &&
      (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)))
  ) {
    return null;
  }

  return environments.map((environment) => (
    <EnvironmentVoiceReporter
      key={environment.environmentId}
      environmentId={environment.environmentId}
      durableInbox={environment.serverConfig?.environment.capabilities.jarvisReportInbox === true}
      protocolVersion={
        environment.serverConfig?.environment.capabilities.jarvisReportInboxVersion === 2 ? 2 : 1
      }
      onRelayConnection={onRelayConnection}
    />
  ));
}
