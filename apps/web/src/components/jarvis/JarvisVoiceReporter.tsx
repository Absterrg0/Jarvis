import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, JarvisVoiceReport, JarvisVoiceReportBatch } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron, isJarvisCompanionRelay } from "../../env";
import { randomUUID } from "../../lib/utils";
import { publishJarvisAttentionTarget } from "../../jarvisBus";
import {
  areJarvisVoiceReportsEnabled,
  isPreferredJarvisSpeaker,
  onJarvisPreferencesChanged,
} from "../../jarvisPreferences";
import { useEnvironmentConnectionState, useEnvironments } from "../../state/environments";
import { jarvisEnvironment } from "../../state/jarvis";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  companionReportStatus,
  enqueueJarvisPresentation,
  retryJarvisDelivery,
  speakerPriority,
  spokenReportText,
} from "./JarvisVoiceReporter.logic";

const SEEN_REPORTS_KEY = "t3code:jarvis:spoken-reports:v1";
const MAX_SEEN_REPORTS = 100;
const DEVICE_ID_KEY = "t3code:jarvis:device-id:v1";
function deviceId(): string {
  const existing = sessionStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const created = randomUUID();
  sessionStorage.setItem(DEVICE_ID_KEY, created);
  return created;
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
  if (window.jarvisCompanion?.speak) {
    return window.jarvisCompanion.speak(text).then(
      () => true,
      () => false,
    );
  }
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || "en-US";
    utterance.rate = 1.03;
    utterance.addEventListener("end", () => resolve(true), { once: true });
    utterance.addEventListener("error", () => resolve(false), { once: true });
    window.speechSynthesis.speak(utterance);
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
        for (const delivery of batch.deliveries) {
          if (!active.current) return;
          if (durableInbox && !currentDeliverySequences.current.has(delivery.sequence)) {
            continue;
          }
          const report = delivery.report;
          const presentationKey = durableInbox ? String(delivery.sequence) : report.reportId;
          if (presented.current.has(presentationKey)) continue;
          if (!active.current) return;
          publishJarvisAttentionTarget({
            environmentId,
            projectId: report.projectId,
            threadId: report.threadId,
            threadTitle: report.threadTitle,
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
                isActive: deliveryActive,
                wait: () => new Promise((resolve) => window.setTimeout(resolve, 1_000)),
              });
            let claim = await claimReport();
            if (claim === null) return;
            if (durableInbox) {
              while (
                !claim.granted &&
                claim.speechState !== "already-spoken" &&
                claim.speechState !== "missing" &&
                deliveryActive()
              ) {
                await new Promise((resolve) => window.setTimeout(resolve, 5_000));
                claim = await claimReport();
                if (claim === null) return;
              }
            }
            if (
              durableInbox &&
              !claim.granted &&
              claim.speechState !== "already-spoken" &&
              claim.speechState !== "missing"
            ) {
              return;
            }
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
              if (!spoken) await window.jarvisCompanion?.prepareSpeech?.();
              if (!active.current) return;
              if (!spoken) spoken = await speakReport(environmentId, report, !durableInbox);
              if (durableInbox) {
                while (!spoken && active.current) {
                  await new Promise((resolve) => window.setTimeout(resolve, 1_000));
                  claim = await claimReport();
                  if (claim === null) return;
                  if (
                    claim.speechState === "already-spoken" ||
                    claim.speechState === "leased" ||
                    claim.speechState === "missing"
                  ) {
                    spoken = true;
                    break;
                  }
                  if (!claim.granted) continue;
                  spoken = await speakReport(environmentId, report, false);
                }
              }
              if (!spoken) {
                presentationPending = true;
                break;
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
                  wait: () => new Promise((resolve) => window.setTimeout(resolve, 1_000)),
                });
                if (confirmation === null) return;
                if (confirmation.state === "lease-lost") {
                  presentationPending = false;
                }
              }
            }
          } catch {
            presentationPending = true;
            break;
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
                input: { throughSequence: batch.batchThrough },
              }),
            isActive: deliveryActive,
            wait: () => new Promise((resolve) => window.setTimeout(resolve, 1_000)),
          });
          if (acknowledgement !== null && presented.current.size > 1_024) {
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
  const result = useAtomValue(jarvisEnvironment.reportInbox({ environmentId, input: {} }));
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
    (window.jarvisCompanion?.speak === undefined &&
      (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)))
  ) {
    return null;
  }

  return environments.map((environment) =>
    environment.serverConfig?.environment.capabilities.jarvisReportInbox === true ? (
      <DurableEnvironmentVoiceReporter
        key={environment.environmentId}
        environmentId={environment.environmentId}
        onRelayConnection={onRelayConnection}
      />
    ) : (
      <LegacyEnvironmentVoiceReporter
        key={environment.environmentId}
        environmentId={environment.environmentId}
        onRelayConnection={onRelayConnection}
      />
    ),
  );
}
