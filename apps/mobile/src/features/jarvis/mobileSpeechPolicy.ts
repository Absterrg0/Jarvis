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

const MAX_SPOKEN_SUMMARY_LENGTH = 240;

/**
 * Spoken completions stay short: the first sentences, never the whole
 * report. Approvals, questions, and failures speak in full because the user
 * must hear every word to act on them.
 */
export function mobileSpeechText(event: { readonly kind: string; readonly text: string }): string {
  if (event.kind !== "completed") return event.text;
  const sentences = event.text.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [];
  const short = sentences.slice(0, 2).join(" ").replace(/\s+/gu, " ").trim();
  const text = short.length > 0 ? short : event.text;
  return text.length <= MAX_SPOKEN_SUMMARY_LENGTH
    ? text
    : `${text.slice(0, MAX_SPOKEN_SUMMARY_LENGTH - 1).trim()}…`;
}
