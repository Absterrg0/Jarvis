import { EnvironmentId, ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDesktopJarvisOrbCatalog,
  buildDesktopJarvisOrbAgents,
  isDesktopJarvisOrbSelectionValid,
} from "./JarvisDesktopOrb.bridge";

function provider(nodeId: string, instanceId: string, overrides: Record<string, unknown> = {}) {
  return {
    nodeId,
    nodeLabel: nodeId,
    available: true,
    snapshot: {
      instanceId,
      driver: instanceId,
      displayName: instanceId,
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: new Date().toISOString(),
      models: [
        { slug: "alpha", name: "Alpha", isCustom: false, capabilities: null },
        { slug: "beta", name: "Beta", isCustom: false, capabilities: null },
      ],
      ...overrides,
    },
  } as never;
}

describe("JarvisDesktopOrb bridge", () => {
  it("passes the owning node's real providers through as one preferred row each", () => {
    const catalog = buildDesktopJarvisOrbCatalog({
      providers: [provider("node-a", "claudeAgent"), provider("node-b", "codex")],
      nodeId: "node-a" as never,
      selected: null,
    });

    // Only the owning node's providers; ids and slugs verbatim, nothing invented.
    // One row per provider with the first advertised model (no isDefault here).
    expect(catalog.providers.map((entry) => entry.instanceId)).toEqual(["claudeAgent"]);
    expect(catalog.providers[0]?.models).toEqual([{ slug: "alpha", name: "Alpha" }]);
    expect(catalog.selected).toBeNull();
    expect(catalog.pendingSelection).toBeNull();
    expect(catalog.error).toBeNull();
  });

  it("prefers the isDefault model for each shortlist row", () => {
    const catalog = buildDesktopJarvisOrbCatalog({
      providers: [
        provider("node-a", "codex", {
          models: [
            { slug: "sol", name: "Sol", isCustom: false, capabilities: null },
            { slug: "astra", name: "Astra", isCustom: false, isDefault: true, capabilities: null },
            { slug: "terra", name: "Terra", isCustom: false, capabilities: null },
          ],
        }),
      ],
      nodeId: "node-a" as never,
      selected: null,
    });

    expect(catalog.providers).toHaveLength(1);
    expect(catalog.providers[0]?.models).toEqual([{ slug: "astra", name: "Astra" }]);
  });

  it("caps the shortlist at six providers with one model each", () => {
    const providers = Array.from({ length: 8 }, (_, index) =>
      provider("node-a", `provider-${index}`),
    );
    const catalog = buildDesktopJarvisOrbCatalog({
      providers,
      nodeId: "node-a" as never,
      selected: null,
    });

    expect(catalog.providers).toHaveLength(6);
    expect(catalog.providers.map((entry) => entry.instanceId)).toEqual([
      "provider-0",
      "provider-1",
      "provider-2",
      "provider-3",
      "provider-4",
      "provider-5",
    ]);
    for (const entry of catalog.providers) {
      expect(entry.models).toHaveLength(1);
    }
  });

  it("skips providers with no advertised models", () => {
    const catalog = buildDesktopJarvisOrbCatalog({
      providers: [provider("node-a", "empty", { models: [] }), provider("node-a", "claudeAgent")],
      nodeId: "node-a" as never,
      selected: null,
    });

    expect(catalog.providers.map((entry) => entry.instanceId)).toEqual(["claudeAgent"]);
  });

  it("keeps unavailable providers listed with their honest flag", () => {
    const catalog = buildDesktopJarvisOrbCatalog({
      providers: [
        {
          nodeId: "node-a",
          nodeLabel: "node-a",
          available: false,
          snapshot: {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            status: "error",
            auth: { status: "authenticated" },
            checkedAt: new Date().toISOString(),
            models: [{ slug: "gpt-5", name: "GPT 5", isCustom: false, capabilities: null }],
          },
        } as never,
      ],
      nodeId: "node-a" as never,
      selected: { instanceId: "codex", model: "gpt-5" },
      pendingSelection: { instanceId: "codex", model: "gpt-5" },
      error: "The device rejected this default.",
    });

    expect(catalog.providers[0]?.available).toBe(false);
    expect(catalog.selected).toEqual({ instanceId: "codex", model: "gpt-5" });
    expect(catalog.pendingSelection).toEqual({ instanceId: "codex", model: "gpt-5" });
    expect(catalog.error).toBe("The device rejected this default.");
  });

  it("validates selections by membership, rejecting invented ids", () => {
    const catalog = buildDesktopJarvisOrbCatalog({
      providers: [provider("node-a", "claudeAgent")],
      nodeId: "node-a" as never,
      selected: null,
    });

    expect(
      isDesktopJarvisOrbSelectionValid({ instanceId: "claudeAgent", model: "alpha" }, catalog),
    ).toBe(true);
    // The shortlist offers one preferred model per provider, so the
    // non-preferred sibling model is not a valid orb selection.
    expect(
      isDesktopJarvisOrbSelectionValid({ instanceId: "claudeAgent", model: "beta" }, catalog),
    ).toBe(false);
    // Unknown instance, unknown model, and cross-instance models all fail.
    expect(isDesktopJarvisOrbSelectionValid({ instanceId: "codex", model: "alpha" }, catalog)).toBe(
      false,
    );
    expect(
      isDesktopJarvisOrbSelectionValid({ instanceId: "claudeAgent", model: "gpt-5" }, catalog),
    ).toBe(false);
    expect(isDesktopJarvisOrbSelectionValid({ instanceId: "", model: "alpha" }, catalog)).toBe(
      false,
    );
  });
});

describe("desktop activity catalog", () => {
  const nodeA = EnvironmentId.make("node-a");
  const nodeB = EnvironmentId.make("node-b");
  const task = {
    id: ThreadId.make("shared-thread"),
    environmentId: nodeA,
    projectId: ProjectId.make("project"),
    title: "Review relay connection",
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    session: { status: "running" as const },
  };
  const catalog = {
    nodes: [
      { nodeId: nodeA, label: "Laptop", reachability: "online" as const },
      { nodeId: nodeB, label: "Build server", reachability: "offline" as const },
    ],
    projects: [],
    providers: [],
  };

  it("keeps same-thread identities on separate nodes and marks disconnected activity offline", () => {
    const agents = buildDesktopJarvisOrbAgents([task, { ...task, environmentId: nodeB }], catalog);
    expect(agents.map((agent) => [agent.taskRef.executionNodeId, agent.status])).toEqual([
      [nodeA, "running"],
      [nodeB, "offline"],
    ]);
    expect(agents[1]?.nodeLabel).toBe("Build server");
  });

  it("drops completed, archived and unpaired work while preserving waiting and background agents", () => {
    const cases = [
      { ...task, session: { status: "ready" as const } },
      { ...task, archivedAt: "2026-09-12T00:00:00Z" },
      { ...task, environmentId: EnvironmentId.make("removed") },
      { ...task, hasPendingApprovals: true },
      { ...task, session: null, backgroundLiveness: "monitoring" as const },
      { ...task, session: null, backgroundLiveness: "working" as const },
    ];
    expect(buildDesktopJarvisOrbAgents(cases, catalog).map((agent) => agent.status)).toEqual([
      "waiting",
      "monitoring",
      "running",
    ]);
    expect(buildDesktopJarvisOrbAgents([task], null)).toEqual([]);
  });
});
