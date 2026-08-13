import type { JarvisVoiceReport } from "@t3tools/contracts";

export function speakerPriority(input: {
  /** A paired report-only companion relay must win over every host surface. */
  readonly relay?: boolean;
  readonly preferred: boolean;
  readonly mobile: boolean;
  readonly electron: boolean;
}): number {
  // This renderer exists only in the hidden, paired Windows companion. Giving
  // it a distinct tier avoids a nondeterministic tie with the laptop Electron
  // host (both otherwise have the desktop priority of 75).
  if (input.relay) return 200;
  if (input.preferred) return 100;
  if (input.mobile) return 40;
  return input.electron ? 75 : 60;
}

function normalizedSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " Code changes are included in the written output. ")
    .replace(/[`#*_[\]>()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function spokenReportText(report: JarvisVoiceReport): string {
  const output = normalizedSpeechText(report.text).slice(0, 2_000);
  switch (report.kind) {
    case "waiting-for-input":
      return `${report.providerName} needs your input for ${report.threadTitle}. ${output}`;
    case "approval-needed":
      return `${report.providerName} needs approval for ${report.threadTitle}. ${output}`;
    case "failed":
      return `${report.providerName} failed on ${report.threadTitle}. ${output}`;
    case "completed":
      return `${report.providerName} completed ${report.threadTitle}. ${output}`;
  }
}
