import type { EnvironmentId, JarvisTaskRef, ProjectId, ThreadId } from "@t3tools/contracts";

const JARVIS_OPEN_EVENT = "t3code:open-jarvis";
const JARVIS_ONBOARDING_EVENT = "t3code:open-jarvis-onboarding";

export interface JarvisCommandTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly taskRef?: JarvisTaskRef;
}

export function openJarvis(): void {
  window.dispatchEvent(new Event(JARVIS_OPEN_EVENT));
}

export function onOpenJarvis(listener: () => void): () => void {
  window.addEventListener(JARVIS_OPEN_EVENT, listener);
  return () => window.removeEventListener(JARVIS_OPEN_EVENT, listener);
}

/** Open the first-run guide from management or Settings without coupling those surfaces. */
export function openJarvisOnboarding(): void {
  window.dispatchEvent(new Event(JARVIS_ONBOARDING_EVENT));
}

export function onOpenJarvisOnboarding(listener: () => void): () => void {
  window.addEventListener(JARVIS_ONBOARDING_EVENT, listener);
  return () => window.removeEventListener(JARVIS_ONBOARDING_EVENT, listener);
}
