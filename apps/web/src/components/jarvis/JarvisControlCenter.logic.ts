import type {
  JarvisMeshCatalog,
  JarvisMeshNode,
  JarvisMeshProject,
  JarvisMeshProvider,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import type { EnvironmentId } from "@t3tools/contracts";

export interface JarvisControlCenterDevice {
  readonly node: JarvisMeshNode;
  readonly isCurrentDevice: boolean;
  readonly projects: ReadonlyArray<JarvisMeshProject>;
  readonly providers: ReadonlyArray<JarvisMeshProvider>;
}

export interface JarvisControlCenterView {
  readonly summary: {
    readonly devices: number;
    readonly onlineDevices: number;
    readonly projects: number;
    readonly providers: number;
    readonly readyProviders: number;
  };
  readonly devices: ReadonlyArray<JarvisControlCenterDevice>;
}

/** Project the mesh once so rendering each device never rescans the full catalog. */
export function buildJarvisControlCenterView(
  catalog: JarvisMeshCatalog,
  options?: {
    readonly registeredNodes?: ReadonlyArray<JarvisMeshNode>;
    readonly currentNodeId?: EnvironmentId | null;
  },
): JarvisControlCenterView {
  const catalogNodes = new Map(catalog.nodes.map((node) => [node.nodeId, node]));
  // Connections are live; the asynchronously loaded project catalog is not.
  // Keep registered devices visible while catalogs load, and remove unpaired ones.
  const nodes = (options?.registeredNodes ?? catalog.nodes)
    .map((node) => ({ ...catalogNodes.get(node.nodeId), ...node }))
    .sort(
      (left, right) =>
        Number(right.nodeId === options?.currentNodeId) -
        Number(left.nodeId === options?.currentNodeId),
    );
  const onlineNodes = new Map(nodes.map((node) => [node.nodeId, node.reachability === "online"]));
  const projects = catalog.projects.filter((project) => onlineNodes.has(project.ref.nodeId));
  const providers = catalog.providers
    .filter((provider) => onlineNodes.has(provider.nodeId))
    .map((provider) => ({
      ...provider,
      available: provider.available && onlineNodes.get(provider.nodeId) === true,
    }));
  const projectsByNode = new Map<string, JarvisMeshProject[]>();
  const providersByNode = new Map<string, JarvisMeshProvider[]>();

  for (const project of projects) {
    const projects = projectsByNode.get(project.ref.nodeId) ?? [];
    projects.push(project);
    projectsByNode.set(project.ref.nodeId, projects);
  }
  for (const provider of providers) {
    const providers = providersByNode.get(provider.nodeId) ?? [];
    providers.push(provider);
    providersByNode.set(provider.nodeId, providers);
  }

  return {
    summary: {
      devices: nodes.length,
      onlineDevices: nodes.filter((node) => node.reachability === "online").length,
      projects: projects.length,
      providers: providers.length,
      readyProviders: providers.filter((provider) => provider.available).length,
    },
    devices: nodes.map((node) => ({
      node,
      isCurrentDevice: node.nodeId === options?.currentNodeId,
      projects: projectsByNode.get(node.nodeId) ?? [],
      providers: providersByNode.get(node.nodeId) ?? [],
    })),
  };
}
