export type CompanionReportConnectionPhase =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "needs-pairing";

export type CompanionReportConnection = Readonly<{
  readonly phase: CompanionReportConnectionPhase;
  readonly detail?: string;
}>;

/** Small presentation contract for the tray; transport errors stay actionable. */
export function reportConnectionPresentation(connection: CompanionReportConnection): {
  readonly label: string;
  readonly action: "retry" | "pair" | "none";
} {
  switch (connection.phase) {
    case "connected":
      return { label: "Task reports connected", action: "none" };
    case "connecting":
      return { label: "Connecting task reports…", action: "none" };
    case "needs-pairing":
      return { label: "Task connection needs pairing", action: "pair" };
    case "error":
      return {
        label:
          connection.detail === undefined
            ? "Task connection failed"
            : "Task connection needs attention",
        action: "retry",
      };
    case "reconnecting":
      return { label: "Reconnecting task reports…", action: "retry" };
  }
}
