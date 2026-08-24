import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, JarvisVoiceReport, JarvisVoiceReportBatch } from "@t3tools/contracts";
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
import { useEnvironmentConnectionState, useEnvironments } from "../../state/environments";
import { jarvisEnvironment } from "../../state/jarvis";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  companionReportStatus,
  canMountJarvisVoiceReporter,
  enqueueJarvisPresentation,
  isJarvisReportForIdentity,
  retryJarvisDelivery,
  speakerPriority,
  spokenReportText,
} from "./JarvisVoiceReporter.logic";
import { desktopVoiceAllowsBrowserFallback } from "./JarvisManager.logic";

const SEEN_REPORTS_KEY = "t3code:jarvis:spoken-reports:v1";
const MAX_SEEN_REPORTS = 100;
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

function speakReport(
  environmentId: EnvironmentId,
  report: JarvisVoiceReport,
  remember = true,
): Promise<boolean> {
  const reportKey = `${environmentId}:${report.reportId}`;
  if (remember && !rememberReport(reportKey)) return Promise.resolve(true);
  const text = spokenReportText(report);
  const speakFallback = (): Promise<boolean> => {
    if (window.jarvisCompanion?.speak) {
      return window.jarvisCompanion.speak(text).then(
        () => true,
        () => false,
      );
    }
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
        resolve(false);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = navigator.language || "en-US";
      utterance.rate = 1.03;
      utterance.addEventListener("end", () => resolve(true), { once: true });
      utterance.addEventListener("error", () => resolve(false), { once: true });
      window.speechSynthesis.speak(utterance);
    });
  };
  if (window.desktopBridge?.jarvisVoice) {
    const speakAfterDesktopFailure = async (): Promise<boolean> => {
      try {
        const current = await window.desktopBridge!.jarvisVoice!.getState();
        if (!desktopVoiceAllowsBrowserFallback(current)) return false;
      } catch {
        return false;
      }
      return speakFallback();
    };
    return window.desktopBridge.jarvisVoice.speak(text).then(
      (result) => (result.accepted ? true : speakAfterDesktopFailure()),
      () => speakAfterDesktopFailure(),
    );
  }
  return speakFallback();
}

function surfaceJarvisVoiceDeliveryFailure(): void {
  const description =
    "Voice delivery is paused after repeated failures. Reconnect or retry to speak this report.";
  toastManager.add({
    type: "warning",
    title: "Jarvis voice delivery paused",
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
  const presentationQueue = useRef(Promise.resolve());
  const presented = useRef(new Set<string>());
  const currentDeliverySequences = useRef<ReadonlySet<number>>(new Set());
  const active = useRef(true);
  const connected = connection.data?.phase === "connected";
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const deliveryActive = () => active.current && connectedRef.current;

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
            description:
              "Open T3 task history to review work completed while this device was away.",
            timeout: 10_000,
          });
          await window.jarvisCompanion
            ?.taskStatus(
              "warning",
              "Some older Jarvis reports expired before this device reconnected. Open T3 to review the full task history.",
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
          await window.jarvisCompanion
            ?.setAttentionTarget({
              projectId: report.projectId,
              threadId: report.threadId,
              reportKind: report.kind,
            })
            .catch(() => undefined);
          await window.jarvisCompanion
            ?.taskStatus(status.state, status.detail, status.kind, {
              stream: report.kind === "completed",
              statusId: report.reportId,
            })
            .catch(() => undefined);
          try {
            if (!active.current) return;
            const claimReport = () =>
              retryJarvisDelivery({
                run: () =>
                  claimSpeaker({
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
                  }),
                accept: (candidate) =>
                  candidate.granted ||
                  candidate.speechState === "already-spoken" ||
                  candidate.speechState === "missing",
                isActive: deliveryActive,
                wait: waitForJarvisDelivery,
              });
            const claimResult = await claimReport();
            if (claimResult.status === "cancelled") return;
            if (claimResult.status === "exhausted") {
              markDeliveryRetryable();
              continue;
            }
            let claim = claimResult.value;
            if (durableInbox && claim.speechState === "missing") {
              presented.current.add(presentationKey);
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
                  await window.desktopBridge.jarvisVoice.prepare().catch(() => undefined);
                } else {
                  await window.jarvisCompanion?.prepareSpeech?.();
                }
              }
              if (!active.current) return;
              if (!spoken) spoken = await speakReport(environmentId, report, !durableInbox);
              if (durableInbox) {
                const speechResult = await retryJarvisDelivery({
                  run: async () => {
                    const nextClaimResult = await claimReport();
                    if (nextClaimResult.status !== "succeeded") return { _tag: "Failure" };
                    claim = nextClaimResult.value;
                    if (claim.speechState === "already-spoken" || claim.speechState === "missing") {
                      return { _tag: "Success", value: true };
                    }
                    if (spoken) {
                      return { _tag: "Success", value: true };
                    }
                    if (!claim.granted) return { _tag: "Failure" };
                    return (await speakReport(environmentId, report, false))
                      ? { _tag: "Success", value: true }
                      : { _tag: "Failure" };
                  },
                  isActive: deliveryActive,
                  wait: waitForJarvisDelivery,
                });
                if (speechResult.status === "cancelled") return;
                if (speechResult.status === "exhausted") {
                  markDeliveryRetryable();
                  continue;
                }
                spoken = speechResult.value;
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
  ]);

  useEffect(() => {
    onRelayConnection(environmentId, connection.data?.phase === "connected");
    return () => onRelayConnection(environmentId, false);
  }, [connection.data?.phase, environmentId, onRelayConnection]);

  return null;
}

function DurableEnvironmentVoiceReporter({
  environmentId,
  onRelayConnection,
}: {
  readonly environmentId: EnvironmentId;
  readonly onRelayConnection: (environmentId: EnvironmentId, connected: boolean) => void;
}) {
  const result = useAtomValue(
    jarvisEnvironment.reportInbox({
      environmentId,
      input: { originInteractionId: jarvisReporterIdentity() },
    }),
  );
  return (
    <EnvironmentVoiceReporterBody
      environmentId={environmentId}
      durableInbox
      batch={AsyncResult.isSuccess(result) ? result.value : null}
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
  onRelayConnection,
}: {
  readonly environmentId: EnvironmentId;
  readonly durableInbox: boolean;
  readonly onRelayConnection: (environmentId: EnvironmentId, connected: boolean) => void;
}) {
  const sessionState = useEnvironmentSessionState(environmentId);
  if (!canMountJarvisVoiceReporter(sessionState.data)) return null;
  return durableInbox ? (
    <DurableEnvironmentVoiceReporter
      environmentId={environmentId}
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
      onRelayConnection={onRelayConnection}
    />
  ));
}
