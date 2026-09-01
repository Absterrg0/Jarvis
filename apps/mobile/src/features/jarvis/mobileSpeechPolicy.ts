import type { JarvisPresentationKind } from "@t3tools/contracts";

export type MobileSpeechKind =
  | "acknowledgement"
  | "progress"
  | "needs-input"
  | "approval-needed"
  | "completed"
  | "failed";

/** Keep progress visual; speak brief acknowledgements, decisions, and terminal outcomes. */
export function shouldSpeakMobile(kind: MobileSpeechKind): boolean {
  switch (kind) {
    case "acknowledgement":
    case "needs-input":
    case "approval-needed":
    case "completed":
    case "failed":
      return true;
    case "progress":
      return false;
  }
}

export function mobileSpeechKindForPresentation(
  kind: JarvisPresentationKind,
): Exclude<MobileSpeechKind, "acknowledgement" | "progress"> {
  switch (kind) {
    case "waiting-for-input":
      return "needs-input";
    case "approval-needed":
    case "completed":
    case "failed":
      return kind;
  }
}
