import type {
  JarvisMeshCatalog,
  JarvisMeshNode,
  JarvisMeshProject,
  JarvisMeshProvider,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";

export interface JarvisControlCenterDevice {
  readonly node: JarvisMeshNode;
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
export function buildJarvisControlCenterView(catalog: JarvisMeshCatalog): JarvisControlCenterView {
  const projectsByNode = new Map<string, JarvisMeshProject[]>();
  const providersByNode = new Map<string, JarvisMeshProvider[]>();

  for (const project of catalog.projects) {
    const projects = projectsByNode.get(project.ref.nodeId) ?? [];
    projects.push(project);
    projectsByNode.set(project.ref.nodeId, projects);
  }
  for (const provider of catalog.providers) {
    const providers = providersByNode.get(provider.nodeId) ?? [];
    providers.push(provider);
    providersByNode.set(provider.nodeId, providers);
  }

  return {
    summary: {
      devices: catalog.nodes.length,
      onlineDevices: catalog.nodes.filter((node) => node.reachability === "online").length,
      projects: catalog.projects.length,
      providers: catalog.providers.length,
      readyProviders: catalog.providers.filter((provider) => provider.available).length,
    },
    devices: catalog.nodes.map((node) => ({
      node,
      projects: projectsByNode.get(node.nodeId) ?? [],
      providers: providersByNode.get(node.nodeId) ?? [],
    })),
  };
}
