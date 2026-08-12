import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, JarvisVoiceReport } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { publishJarvisAttentionTarget } from "../../jarvisBus";
import {
  areJarvisVoiceReportsEnabled,
  isPreferredJarvisSpeaker,
  onJarvisPreferencesChanged,
} from "../../jarvisPreferences";
import { useEnvironments } from "../../state/environments";
import { jarvisEnvironment } from "../../state/jarvis";
import { useAtomCommand } from "../../state/use-atom-command";
import { speakerPriority, spokenReportText } from "./JarvisVoiceReporter.logic";

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

function speakReport(environmentId: EnvironmentId, report: JarvisVoiceReport): void {
  const reportKey = `${environmentId}:${report.reportId}`;
  if (!rememberReport(reportKey)) return;
  const text = spokenReportText(report);
  if (window.jarvisCompanion?.speak) {
    void window.jarvisCompanion.speak(text);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = navigator.language || "en-US";
  utterance.rate = 1.03;
  window.speechSynthesis.speak(utterance);
}

function EnvironmentVoiceReporter({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(jarvisEnvironment.reports({ environmentId, input: {} }));
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
    void window.jarvisCompanion?.setAttentionTarget({
      projectId: report.projectId,
      threadId: report.threadId,
    });
    void claimSpeaker({
      environmentId,
      input: {
        reportId: report.reportId,
        deviceId: deviceId(),
        priority: speakerPriority({
          preferred: isPreferredJarvisSpeaker(),
          mobile: /Android|iPhone|iPad/iu.test(navigator.userAgent),
          electron: isElectron,
        }),
      },
    }).then((claim) => {
      if (claim._tag === "Success" && claim.value.granted) {
        speakReport(environmentId, report);
      }
    });
  }, [claimSpeaker, environmentId, result]);

  return null;
}

/** Event-driven voice reports: no polling, microphone, or resident speech model. */
export function JarvisVoiceReporter() {
  const { environments } = useEnvironments();
  const [enabled, setEnabled] = useState(areJarvisVoiceReportsEnabled);

  useEffect(() => onJarvisPreferencesChanged(() => setEnabled(areJarvisVoiceReportsEnabled())), []);
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
    />
  ));
}
