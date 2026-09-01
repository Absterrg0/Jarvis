import type { AppStateStatus } from "react-native";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";

export function isAppForegroundTransition(previous: AppStateStatus, next: AppStateStatus): boolean {
  return next === "active" && (previous === "background" || previous === "inactive");
}

export function hasEnvironmentConnected(
  previous: ReadonlyMap<EnvironmentId, EnvironmentConnectionPhase> | null,
  current: ReadonlyArray<Pick<ConnectedEnvironmentSummary, "environmentId" | "connectionState">>,
): boolean {
  if (previous === null) return false;
  return current.some(
    (environment) =>
      environment.connectionState === "connected" &&
      previous.get(environment.environmentId) !== "connected",
  );
}

export function isSelectedTaskDeskNodeCatalogued(
  catalog: { readonly nodes: ReadonlyArray<{ readonly nodeId: EnvironmentId }> },
  selectedNodeId: EnvironmentId | null,
): boolean {
  return selectedNodeId !== null && catalog.nodes.some((node) => node.nodeId === selectedNodeId);
}
