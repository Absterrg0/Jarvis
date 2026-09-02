import type { JarvisProjectRef } from "@t3tools/contracts";
import type { JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";

function sameProjectRef(left: JarvisProjectRef, right: JarvisProjectRef): boolean {
  return left.nodeId === right.nodeId && left.projectId === right.projectId;
}

export function resolveMobileJarvisProject(input: {
  readonly projects: ReadonlyArray<JarvisMeshProject>;
  readonly selectedProjectKey: string | null;
  readonly preferredProjectRef: JarvisProjectRef | undefined;
  readonly activityProjectRefs: ReadonlyArray<JarvisProjectRef>;
  readonly projectKey: (project: JarvisMeshProject) => string;
}): JarvisMeshProject | undefined {
  const selected = input.projects.find(
    (project) => input.projectKey(project) === input.selectedProjectKey,
  );
  if (selected !== undefined) return selected;

  const preferredProjectRef = input.preferredProjectRef;
  if (preferredProjectRef !== undefined) {
    const preferred = input.projects.find((project) =>
      sameProjectRef(project.ref, preferredProjectRef),
    );
    if (preferred !== undefined) return preferred;
  }

  for (const activityProjectRef of input.activityProjectRefs) {
    const active = input.projects.find((project) =>
      sameProjectRef(project.ref, activityProjectRef),
    );
    if (active !== undefined) return active;
  }

  return input.projects.length === 1 ? input.projects[0] : undefined;
}
