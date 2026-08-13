import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, JarvisVoiceReport } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState } from "react";

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
import {
  companionReportStatus,
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

function speakReport(environmentId: EnvironmentId, report: JarvisVoiceReport): Promise<void> {
  const reportKey = `${environmentId}:${report.reportId}`;
  if (!rememberReport(reportKey)) return Promise.resolve();
  const text = spokenReportText(report);
  if (window.jarvisCompanion?.speak) {
    return window.jarvisCompanion.speak(text);
  }
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || "en-US";
    utterance.rate = 1.03;
    utterance.addEventListener("end", () => resolve(), { once: true });
    utterance.addEventListener("error", () => resolve(), { once: true });
    window.speechSynthesis.speak(utterance);
  });
}

function EnvironmentVoiceReporter({
  environmentId,
  onRelayConnection,
}: {
  readonly environmentId: EnvironmentId;
  readonly onRelayConnection: (environmentId: EnvironmentId, connected: boolean) => void;
}) {
  const result = useAtomValue(jarvisEnvironment.reports({ environmentId, input: {} }));
  const connection = useEnvironmentConnectionState(environmentId);
  const claimSpeaker = useAtomCommand(jarvisEnvironment.claimSpeaker, {
    reportFailure: false,
    reportDefect: false,
  });

  useEffect(() => {
    if (!AsyncResult.isSuccess(result)) return;
    const report = result.value;
    publishJarvisAttentionTarget({
      environmentId,
      projectId: report.projectId,
      threadId: report.threadId,
      threadTitle: report.threadTitle,
    });
    const status = companionReportStatus(report);
    void (async () => {
      await window.jarvisCompanion
        ?.setAttentionTarget({
          projectId: report.projectId,
          threadId: report.threadId,
        })
        .catch(() => undefined);
      await window.jarvisCompanion
        ?.taskStatus(status.state, status.detail, status.kind, {
          stream: report.kind === "completed",
          statusId: report.reportId,
        })
        .catch(() => undefined);
      try {
        const claim = await claimSpeaker({
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
        if (claim._tag === "Success" && claim.value.granted) {
          await speakReport(environmentId, report);
        }
      } finally {
        if (report.kind === "completed") {
          await window.jarvisCompanion?.finishTaskStatus?.(report.reportId).catch(() => undefined);
        }
      }
    })();
  }, [claimSpeaker, environmentId, result]);

  useEffect(() => {
    onRelayConnection(environmentId, connection.data?.phase === "connected");
    return () => onRelayConnection(environmentId, false);
  }, [connection.data?.phase, environmentId, onRelayConnection]);

  return null;
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

  return environments.map((environment) => (
    <EnvironmentVoiceReporter
      key={environment.environmentId}
      environmentId={environment.environmentId}
      onRelayConnection={onRelayConnection}
    />
  ));
}
