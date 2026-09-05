import type { MobileJarvisPresentation } from "./JarvisMobileProvider";

/**
 * Project one current presentation per thread for the mobile Task Desk.
 * The provider buffer is newest-first, so the first entry per thread wins:
 * a terminal completion or failure supersedes that thread's earlier
 * approval and input blockers instead of stacking beside them.
 */
export function selectCurrentPresentations(
  presentations: ReadonlyArray<MobileJarvisPresentation>,
  limit = 3,
): ReadonlyArray<MobileJarvisPresentation> {
  const newestByThread = new Map<string, MobileJarvisPresentation>();
  for (const presentation of presentations) {
    const key = `${presentation.executionNodeId}:${presentation.event.threadId}`;
    if (!newestByThread.has(key)) newestByThread.set(key, presentation);
  }
  return [...newestByThread.values()].slice(0, limit);
}
