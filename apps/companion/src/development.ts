// @effect-diagnostics globalDate:off - local diagnostic trace timestamps are an imperative
// development-only boundary, never part of Jarvis orchestration state.
export type CompanionDevelopmentScenario =
  | "completed"
  | "waiting-for-input"
  | "approval-needed"
  | "failed";

export type CompanionDevelopmentLaunch = {
  readonly enabled: boolean;
  readonly dataDir?: string;
  readonly diagnosticsPath?: string;
  readonly recordingDir?: string;
  readonly recognitionScenario?: string;
  readonly injectText?: string;
  readonly simulateReport?: CompanionDevelopmentScenario;
};

export type CompanionDevelopmentStage =
  | "recognition"
  | "interpretation"
  | "project-resolution"
  | "conversation-focus"
  | "dispatch"
  | "provider-execution"
  | "reporting"
  | "speech";

export type CompanionDevelopmentVoiceStatus = {
  readonly state: string;
  readonly detail: string;
  readonly kind: "completed" | "attention" | "error";
};

export type CompanionDevelopmentReport = {
  readonly status: CompanionDevelopmentVoiceStatus;
  readonly spoken: string;
};

export type CompanionDevelopmentDispatchBlocker = "unpaired" | "missing-voice-default";

function option(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const value = argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Development-only controls are inert unless the dedicated flag is present, so
 * release builds cannot accidentally inject a task from a copied command line.
 */
export function resolveCompanionDevelopmentLaunch(
  argv: readonly string[],
  options: { readonly packaged?: boolean } = {},
): CompanionDevelopmentLaunch {
  if (options.packaged === true || !argv.includes("--jarvis-development")) {
    return { enabled: false };
  }
  const dataDir = option(argv, "--dev-data-dir");
  const diagnosticsPath = option(argv, "--diagnostics");
  const recordingDir = option(argv, "--recording-dir");
  const recognitionScenario = option(argv, "--recognition-scenario");
  const injectText = option(argv, "--inject-text");
  const simulated = option(argv, "--simulate-report");
  return {
    enabled: true,
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(diagnosticsPath === undefined ? {} : { diagnosticsPath }),
    ...(recordingDir === undefined ? {} : { recordingDir }),
    ...(recognitionScenario === undefined ? {} : { recognitionScenario }),
    ...(injectText === undefined ? {} : { injectText }),
    ...(simulated === "completed" ||
    simulated === "waiting-for-input" ||
    simulated === "approval-needed" ||
    simulated === "failed"
      ? { simulateReport: simulated }
      : {}),
  };
}

/**
 * Simulated reports must produce the same overlay contract the live relay uses
 * (`companionReportStatus` / `spokenReportText` in the web reporter). Otherwise
 * the development launcher would exercise a fake presentation path.
 */
export function companionDevelopmentReport(
  scenario: CompanionDevelopmentScenario,
): CompanionDevelopmentReport {
  switch (scenario) {
    case "completed":
      return {
        status: {
          state: "Finished — short version",
          detail:
            "I found one serious issue in the admin revocation flow. Type-checking passed, although lint could not run.",
          kind: "completed",
        },
        spoken:
          "I found one serious issue in the admin revocation flow. Type-checking passed, although lint could not run.",
      };
    case "waiting-for-input":
      return {
        status: {
          state: "I need your input",
          detail: "Which database should the next change use?",
          kind: "attention",
        },
        spoken: "I need one quick detail. Which database should the next change use?",
      };
    case "approval-needed":
      return {
        status: {
          state: "One quick approval",
          detail: "Install the project test dependencies, then run the focused suite.",
          kind: "attention",
        },
        spoken:
          "Quick check before I continue. Install the project test dependencies, then run the focused suite.",
      };
    case "failed":
      return {
        status: {
          state: "I hit a snag",
          detail: "The provider disconnected before the turn finished.",
          kind: "error",
        },
        spoken: "I hit a snag. The provider disconnected before the turn finished.",
      };
  }
}

export function companionDevelopmentDispatchBlocker(input: {
  readonly paired: boolean;
  readonly hasVoiceDefault: boolean;
}): CompanionDevelopmentDispatchBlocker | undefined {
  if (!input.paired) return "unpaired";
  if (!input.hasVoiceDefault) return "missing-voice-default";
  return undefined;
}

export function companionDevelopmentDiagnosticRecord(input: {
  readonly at?: string;
  readonly stage: CompanionDevelopmentStage;
  readonly phase: string;
  readonly detail?: Readonly<Record<string, string | boolean | number | undefined>>;
}): string {
  const detail = Object.fromEntries(
    Object.entries(input.detail ?? {}).filter(([, value]) => value !== undefined),
  );
  return `${JSON.stringify({
    at: input.at ?? new Date().toISOString(),
    stage: input.stage,
    phase: input.phase,
    ...detail,
  })}\n`;
}
