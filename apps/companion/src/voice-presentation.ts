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

/** One source of truth for the renderer's semantic state transition. */
export const jarvisPresentationStateByKind: Readonly<Record<string, JarvisPresentationState>> = {
  arming: "listening",
  listening: "listening",
  capturing: "listening",
  checking: "transcribing",
  review: "transcribing",
  routing: "working",
  started: "working",
  attention: "waiting",
  speaking: "speaking",
  error: "error",
  completed: "idle",
  interrupted: "idle",
  ready: "idle",
};

/**
 * Native Companion statuses carry useful, detailed copy and a few transport
 * beats. Keep those statuses intact while giving the visual surface one
 * vocabulary that does not grow with every new backend event.
 */
export function jarvisPresentationStateForKind(kind?: string): JarvisPresentationState {
  return (kind === undefined ? undefined : jarvisPresentationStateByKind[kind]) ?? "idle";
}
