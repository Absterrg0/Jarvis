import type { CirceProjectRef } from "@t3tools/contracts";
import type { CirceMeshProject } from "@circe/client-runtime/circe/mesh";

export function sameProjectRef(left: CirceProjectRef, right: CirceProjectRef): boolean {
  return left.nodeId === right.nodeId && left.projectId === right.projectId;
}

export function resolveMobileCirceProject(input: {
  readonly projects: ReadonlyArray<CirceMeshProject>;
  readonly selectedProjectKey: string | null;
  readonly preferredProjectRef: CirceProjectRef | undefined;
  readonly projectKey: (project: CirceMeshProject) => string;
}): CirceMeshProject | undefined {
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
