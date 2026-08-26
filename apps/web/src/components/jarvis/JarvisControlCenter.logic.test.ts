import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  jarvisNodeCapabilitiesForPreset,
  type ServerProvider,
} from "@t3tools/contracts";
import type { JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { describe, expect, it } from "vite-plus/test";

import { buildJarvisControlCenterView } from "./JarvisControlCenter.logic";

const DESKTOP = EnvironmentId.make("desktop");
const LAPTOP = EnvironmentId.make("laptop");

function provider(instanceId: string, displayName: string, available: boolean): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: available ? "ready" : "error",
    auth: { status: available ? "authenticated" : "unauthenticated" },
    checkedAt: "2026-08-25T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("Jarvis control center view", () => {
  it("shows this device before the mesh catalog finishes loading", () => {
    const view = buildJarvisControlCenterView(
      { nodes: [], projects: [], providers: [] },
      {
        currentNodeId: LAPTOP,
        registeredNodes: [
          {
            nodeId: LAPTOP,
            label: "My laptop",
            reachability: "online",
            capabilities: jarvisNodeCapabilitiesForPreset("full"),
          },
        ],
      },
    );

    expect(view.devices.map((device) => device.node.nodeId)).toEqual([LAPTOP]);
    expect(view.devices[0]?.isCurrentDevice).toBe(true);
    expect(view.summary.onlineDevices).toBe(1);
  });

  it("places this device first without duplicating it and uses live connection status", () => {
    const view = buildJarvisControlCenterView(
      {
        nodes: [
          { nodeId: DESKTOP, label: "Desktop", reachability: "online" },
          { nodeId: LAPTOP, label: "My laptop", reachability: "online" },
        ],
        projects: [],
        providers: [],
      },
      {
        currentNodeId: LAPTOP,
        registeredNodes: [
          { nodeId: DESKTOP, label: "Desktop", reachability: "offline" },
          { nodeId: LAPTOP, label: "My laptop", reachability: "online" },
        ],
      },
    );

    expect(view.devices.map((device) => device.node.nodeId)).toEqual([LAPTOP, DESKTOP]);
    expect(view.devices[1]?.node.reachability).toBe("offline");
    expect(view.summary.onlineDevices).toBe(1);
  });

  it("removes unpaired devices and does not call an offline provider ready", () => {
    const view = buildJarvisControlCenterView(
      {
        nodes: [
          { nodeId: DESKTOP, label: "Desktop", reachability: "online" },
          { nodeId: LAPTOP, label: "Laptop", reachability: "online" },
        ],
        projects: [],
        providers: [
          {
            nodeId: LAPTOP,
            nodeLabel: "Laptop",
            snapshot: provider("codex", "Codex", true),
            available: true,
          },
          {
            nodeId: DESKTOP,
            nodeLabel: "Desktop",
            snapshot: provider("codex", "Codex", true),
            available: true,
          },
        ],
      },
      { registeredNodes: [{ nodeId: LAPTOP, label: "Laptop", reachability: "offline" }] },
    );

    expect(view.devices).toHaveLength(1);
    expect(view.devices[0]?.providers[0]?.available).toBe(false);
    expect(view.devices[0]?.isCurrentDevice).toBe(false);
    expect(view.summary).toEqual({
      devices: 1,
      onlineDevices: 0,
      projects: 0,
      providers: 1,
      readyProviders: 0,
    });
  });

  it("groups projects and providers under their device and preserves offline devices", () => {
    const desktopProvider = provider("desktop-codex", "Desktop Codex", true);
    const laptopProvider = provider("laptop-codex", "Laptop Codex", false);
    const catalog: JarvisMeshCatalog = {
      nodes: [
        {
          nodeId: DESKTOP,
          label: "Desktop",
          reachability: "online",
          capabilities: jarvisNodeCapabilitiesForPreset("full"),
        },
        {
          nodeId: LAPTOP,
          label: "Laptop",
          reachability: "offline",
          capabilities: jarvisNodeCapabilitiesForPreset("controller"),
          catalogError: "Not connected",
          catalogErrorKind: "unreachable",
        },
      ],
      projects: [
        {
          ref: { nodeId: DESKTOP, projectId: ProjectId.make("jarvis") },
          projectId: ProjectId.make("jarvis"),
          title: "Jarvis",
          workspaceRoot: "/work/jarvis",
          repositoryNames: ["jarvis"],
          aliases: [],
          aliasDetails: [],
          nodeLabel: "Desktop",
        },
      ],
      providers: [
        { nodeId: DESKTOP, nodeLabel: "Desktop", snapshot: desktopProvider, available: true },
        { nodeId: LAPTOP, nodeLabel: "Laptop", snapshot: laptopProvider, available: false },
      ],
    };

    const view = buildJarvisControlCenterView(catalog);

    expect(view.summary).toEqual({
      devices: 2,
      onlineDevices: 1,
      projects: 1,
      providers: 2,
      readyProviders: 1,
    });
    expect(view.devices.map((device) => device.node.label)).toEqual(["Desktop", "Laptop"]);
    expect(view.devices[0]?.projects.map((project) => project.title)).toEqual(["Jarvis"]);
    expect(view.devices[0]?.providers.map((entry) => entry.snapshot.displayName)).toEqual([
      "Desktop Codex",
    ]);
    expect(view.devices[1]?.node.reachability).toBe("offline");
    expect(view.devices[1]?.providers[0]?.available).toBe(false);
  });
});
