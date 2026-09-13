import type { EnvironmentId } from "@t3tools/contracts";
import {
  circeMeshNodeReadiness,
  type CirceMeshCatalog,
  type CirceMeshNodeRecoveryAction,
} from "@circe/client-runtime/circe/mesh";

export interface CirceRouteNodeIssue {
  readonly nodeId: EnvironmentId;
  readonly label: string;
  readonly loading: boolean;
  readonly message: string | null;
  readonly recovery: CirceMeshNodeRecoveryAction | null;
}

/**
 * Project catalog nodes into the per-node status rows the Circe route
 * screen renders. Reads catalog state only, never the transient command
 * message, so a service failure stays visible after a partial refresh
 * reports Success. Ready nodes (including healthy loaded-empty ones) are
 * excluded so healthy nodes remain usable while a peer fails.
 */
export function describeCirceRouteNodeIssues(
  catalog: CirceMeshCatalog | null,
): ReadonlyArray<CirceRouteNodeIssue> {
  if (catalog === null) return [];
  const issues: CirceRouteNodeIssue[] = [];
  for (const node of catalog.nodes) {
    const readiness = circeMeshNodeReadiness(node);
    if (readiness.status === "ready") continue;
    if (readiness.status === "loading") {
      issues.push({
        nodeId: node.nodeId,
        label: node.label,
        loading: true,
        message: null,
        recovery: null,
      });
      continue;
    }
    issues.push({
      nodeId: node.nodeId,
      label: node.label,
      loading: false,
      message: readiness.message,
      recovery: readiness.recovery,
    });
  }
  return issues;
}
