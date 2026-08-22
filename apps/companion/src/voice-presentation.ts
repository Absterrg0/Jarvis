/** The small, stable state vocabulary shared by the Companion presentation. */
export const jarvisPresentationStates = [
  "idle",
  "listening",
  "transcribing",
  "working",
  "waiting",
  "speaking",
  "error",
] as const;

export type JarvisPresentationState = (typeof jarvisPresentationStates)[number];

/**
 * Native Companion statuses carry useful, detailed copy and a few transport
 * beats. Keep those statuses intact while giving the visual surface one
 * vocabulary that does not grow with every new backend event.
 */
export function jarvisPresentationStateForKind(kind?: string): JarvisPresentationState {
  switch (kind) {
    case "listening":
    case "capturing":
    case "arming":
      return "listening";
    case "checking":
    case "review":
      return "transcribing";
    case "routing":
    case "started":
      return "working";
    case "attention":
      return "waiting";
    case "speaking":
      return "speaking";
    case "error":
      return "error";
    case "completed":
    case "interrupted":
    case "ready":
    case undefined:
      return "idle";
    default:
      return "idle";
  }
}
