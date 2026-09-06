import type { JarvisProjectRef } from "@t3tools/contracts";
import type { JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";

export function sameProjectRef(left: JarvisProjectRef, right: JarvisProjectRef): boolean {
  return left.nodeId === right.nodeId && left.projectId === right.projectId;
}

export function resolveMobileJarvisProject(input: {
  readonly projects: ReadonlyArray<JarvisMeshProject>;
  readonly selectedProjectKey: string | null;
  readonly preferredProjectRef: JarvisProjectRef | undefined;
  readonly projectKey: (project: JarvisMeshProject) => string;
}): JarvisMeshProject | undefined {
  // An explicit selection stays pinned across catalog outage or removal: when
  // its project is absent, no fallback may silently retarget the command. The
  // caller retains the key and reports the target unavailable until it returns
  // or the user explicitly reselects.
  if (input.selectedProjectKey !== null) {
    return input.projects.find((project) => input.projectKey(project) === input.selectedProjectKey);
  }

  const preferredProjectRef = input.preferredProjectRef;
  if (preferredProjectRef !== undefined) {
    return input.projects.find((project) => sameProjectRef(project.ref, preferredProjectRef));
  }

  // Truly no prior selection: a lone project is a safe first-use default, but
  // activity and reports never choose authority.
  return input.projects.length === 1 ? input.projects[0] : undefined;
}
