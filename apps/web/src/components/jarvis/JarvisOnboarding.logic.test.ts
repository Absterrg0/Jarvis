import { describe, expect, it } from "vite-plus/test";

import {
  canAutoOpenJarvisOnboarding,
  classifyJarvisOnboardingProvider,
  jarvisConnectionRouteLabel,
  jarvisNodeCapabilitySummary,
  jarvisNodePresetLabel,
  jarvisOnboardingProviderStatusLabel,
  jarvisOnboardingReadiness,
  jarvisOnboardingExecutionNodeId,
  jarvisOnboardingExecutionNodeSelection,
  jarvisOnboardingNextStep,
  jarvisOnboardingPreviousStep,
  jarvisOnboardingSteps,
  jarvisRefreshRequestIsCurrent,
  validateJarvisNodeLabel,
  jarvisTailscaleStatus,
  readJarvisOnboardingCompletion,
  writeJarvisOnboardingCompletion,
} from "./JarvisOnboarding.logic";

describe("Jarvis onboarding presentation", () => {
  it("accepts only the latest catalog refresh response", () => {
    expect(jarvisRefreshRequestIsCurrent({ requestId: 4, latestRequestId: 4 })).toBe(true);
    expect(jarvisRefreshRequestIsCurrent({ requestId: 3, latestRequestId: 4 })).toBe(false);
  });

  it("exposes the guided setup sequence in the product order", () => {
    expect(jarvisOnboardingSteps.map((step) => step.id)).toEqual(["device", "essentials", "ready"]);
  });

  it("keeps guided navigation bounded while allowing completed steps to be revisited", () => {
    expect(jarvisOnboardingNextStep("device")).toBe("essentials");
    expect(jarvisOnboardingPreviousStep("ready")).toBe("essentials");
    expect(jarvisOnboardingPreviousStep("device")).toBe("device");
    expect(jarvisOnboardingNextStep("ready")).toBe("ready");
  });

  it("validates and trims the persisted device label boundary", () => {
    expect(validateJarvisNodeLabel("  Studio node  ")).toEqual({
      valid: true,
      value: "Studio node",
    });
    expect(validateJarvisNodeLabel("   ").valid).toBe(false);
    expect(validateJarvisNodeLabel("x".repeat(81)).valid).toBe(false);
  });

  it("does not steal an active attention surface on first mount", () => {
    expect(
      canAutoOpenJarvisOnboarding({
        companionMode: false,
        attentionTargetPresent: true,
        attemptMade: false,
        completionStored: false,
      }),
    ).toBe(false);
    expect(
      canAutoOpenJarvisOnboarding({
        companionMode: false,
        attentionTargetPresent: false,
        attemptMade: false,
        completionStored: false,
      }),
    ).toBe(true);
  });

  it("distinguishes ready, sign-in, and missing provider states", () => {
    expect(
      classifyJarvisOnboardingProvider({
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
      }),
    ).toBe("ready");
    expect(
      classifyJarvisOnboardingProvider({
        enabled: true,
        installed: true,
        status: "warning",
        auth: { status: "unauthenticated" },
      }),
    ).toBe("sign-in");
    expect(
      classifyJarvisOnboardingProvider({
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "unknown" },
        availability: "unavailable",
      }),
    ).toBe("not-installed");
    expect(
      classifyJarvisOnboardingProvider({
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "unknown" },
        availability: "available",
      }),
    ).toBe("ready");
    expect(jarvisOnboardingProviderStatusLabel("sign-in")).toBe("Sign in");
  });

  it("labels the configured node without making the preset user-editable", () => {
    expect(jarvisNodePresetLabel("full")).toBe("Full node");
    expect(
      jarvisNodeCapabilitySummary({
        preset: "controller",
        ui: true,
        parakeet: true,
        kokoro: true,
        execution: false,
        projects: false,
        providers: false,
      }),
    ).toBe("UI · voice");
  });

  it("describes local, Tailscale, and relay connections", () => {
    expect(
      jarvisConnectionRouteLabel({ targetTag: "PrimaryConnectionTarget", displayUrl: null }),
    ).toBe("Local route");
    expect(
      jarvisConnectionRouteLabel({
        targetTag: "BearerConnectionTarget",
        displayUrl: "https://desktop.tail123.ts.net",
        advertisedEndpoints: [
          {
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "private-network",
              isAddon: true,
            },
            httpBaseUrl: "https://desktop.tail123.ts.net",
            status: "available",
          },
        ],
      }),
    ).toBe("Tailscale route");
    expect(
      jarvisConnectionRouteLabel({ targetTag: "RelayConnectionTarget", displayUrl: null }),
    ).toBe("Relay route");
    expect(
      jarvisConnectionRouteLabel({
        targetTag: "BearerConnectionTarget",
        displayUrl: "https://desktop.ts.net.evil.example",
      }),
    ).toBe("Remote route");
  });

  it("detects a Tailscale route without claiming daemon connectivity", () => {
    expect(
      jarvisTailscaleStatus({
        connectionPhase: "connected",
        targetTag: "BearerConnectionTarget",
        displayUrl: "https://desktop.example.ts.net",
      }),
    ).toBe("not-detected");
    expect(
      jarvisTailscaleStatus({
        connectionPhase: "connected",
        targetTag: "BearerConnectionTarget",
        displayUrl: "http://100.64.20.7:3773",
      }),
    ).toBe("not-detected");
    expect(
      jarvisTailscaleStatus({
        connectionPhase: "connected",
        targetTag: "PrimaryConnectionTarget",
        displayUrl: null,
      }),
    ).toBe("not-detected");
  });

  it("requires an available advertised endpoint for Tailscale classification", () => {
    expect(
      jarvisTailscaleStatus({
        connectionPhase: "connected",
        targetTag: "BearerConnectionTarget",
        displayUrl: "https://desktop.example.test/",
        advertisedEndpoints: [
          {
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "private-network",
              isAddon: true,
            },
            httpBaseUrl: "https://desktop.example.test",
            status: "available",
          },
        ],
      }),
    ).toBe("route-detected");
    expect(
      jarvisTailscaleStatus({
        connectionPhase: "connected",
        targetTag: "BearerConnectionTarget",
        displayUrl: "https://desktop.example.ts.net",
        advertisedEndpoints: [
          {
            provider: { id: "manual", label: "Manual", kind: "manual", isAddon: false },
            httpBaseUrl: "https://desktop.example.ts.net",
            status: "available",
          },
        ],
      }),
    ).toBe("not-detected");
    expect(
      jarvisConnectionRouteLabel({
        targetTag: "BearerConnectionTarget",
        displayUrl: "https://desktop.example.test",
        advertisedEndpoints: [
          {
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "private-network",
              isAddon: true,
            },
            httpBaseUrl: "https://desktop.example.test",
            status: "unavailable",
          },
        ],
      }),
    ).toBe("Remote route");
  });

  it("does not infer Tailscale from hostnames or CGNAT-shaped addresses", () => {
    expect(
      jarvisTailscaleStatus({
        connectionPhase: "connected",
        targetTag: "BearerConnectionTarget",
        displayUrl: "https://desktop.ts.net.evil.example",
      }),
    ).toBe("not-detected");
    expect(
      jarvisTailscaleStatus({
        connectionPhase: "connected",
        targetTag: "BearerConnectionTarget",
        displayUrl: "http://100.100.20.7:3773",
      }),
    ).toBe("not-detected");
  });

  it("requires local execution resources before Full and Headless nodes are ready", () => {
    const full = {
      preset: "full" as const,
      ui: true,
      parakeet: true,
      kokoro: true,
      execution: true,
      projects: true,
      providers: true,
    } as const;
    const catalog = {
      nodes: [
        {
          nodeId: "desktop",
          label: "Desktop",
          reachability: "online" as const,
          capabilities: full,
        },
      ],
      projects: [
        {
          ref: { nodeId: "desktop", projectId: "rivvl" },
          title: "Rivvl",
          workspaceRoot: "/workspace/rivvl",
          repositoryNames: [],
          aliases: [],
          nodeLabel: "Desktop",
        },
      ],
      providers: [
        {
          nodeId: "desktop",
          nodeLabel: "Desktop",
          available: true,
          snapshot: {
            instanceId: "codex",
            driver: "codex",
            displayName: "Codex",
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            availability: "available",
          },
        },
      ],
    } as const;
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "desktop",
        primaryReachability: "online",
        capabilities: full,
        catalog,
      }),
    ).toMatchObject({ ready: true, executionNodeId: "desktop" });
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "desktop",
        primaryReachability: "online",
        capabilities: full,
        catalog: { ...catalog, projects: [] },
      }),
    ).toMatchObject({ ready: false, reason: "project-required" });
  });

  it("uses a paired execution node for Controller readiness", () => {
    const controller = {
      preset: "controller" as const,
      ui: true,
      parakeet: true,
      kokoro: true,
      execution: false,
      projects: false,
      providers: false,
    };
    const full = {
      ...controller,
      preset: "full" as const,
      execution: true,
      projects: true,
      providers: true,
    };
    const catalog = {
      nodes: [
        {
          nodeId: "laptop",
          label: "Laptop",
          reachability: "online" as const,
          capabilities: controller,
        },
        {
          nodeId: "desktop",
          label: "Desktop",
          reachability: "online" as const,
          capabilities: full,
        },
      ],
      projects: [
        {
          ref: { nodeId: "desktop", projectId: "rivvl" },
          title: "Rivvl",
          workspaceRoot: "/workspace/rivvl",
          repositoryNames: [],
          aliases: [],
          nodeLabel: "Desktop",
        },
      ],
      providers: [
        {
          nodeId: "desktop",
          nodeLabel: "Desktop",
          available: true,
          snapshot: {
            instanceId: "codex",
            driver: "codex",
            displayName: "Codex",
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            availability: "available",
          },
        },
      ],
    } as const;
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "laptop",
        primaryReachability: "online",
        capabilities: controller,
        catalog,
      }),
    ).toMatchObject({ ready: true, executionNodeId: "desktop" });
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "laptop",
        primaryReachability: "online",
        capabilities: controller,
        catalog: { ...catalog, nodes: catalog.nodes.slice(0, 1) },
      }),
    ).toMatchObject({ ready: false, reason: "execution-node-required" });
  });

  it("chooses the most actionable online execution node for Controller setup", () => {
    const controller = {
      preset: "controller" as const,
      ui: true,
      parakeet: true,
      kokoro: true,
      execution: false,
      projects: false,
      providers: false,
    };
    const full = {
      ...controller,
      preset: "full" as const,
      execution: true,
      projects: true,
      providers: true,
    };
    const catalog = {
      nodes: [
        { nodeId: "controller", reachability: "online" as const, capabilities: controller },
        { nodeId: "empty", reachability: "online" as const, capabilities: full },
        { nodeId: "ready", reachability: "online" as const, capabilities: full },
      ],
      projects: [{ ref: { nodeId: "ready", projectId: "jarvis" } }],
      providers: [
        {
          nodeId: "ready",
          snapshot: {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            availability: "available",
          },
        },
      ],
    } as const;
    expect(
      jarvisOnboardingExecutionNodeId({
        primaryNodeId: "controller",
        primaryReachability: "online",
        capabilities: controller,
        catalog,
      }),
    ).toBe("ready");
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "controller",
        primaryReachability: "online",
        capabilities: controller,
        catalog,
      }),
    ).toEqual({ ready: true, executionNodeId: "ready" });
  });

  it("does not claim readiness when the connected node catalog is unavailable", () => {
    const full = {
      preset: "full" as const,
      ui: true,
      parakeet: true,
      kokoro: true,
      execution: true,
      projects: true,
      providers: true,
    };
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "desktop",
        primaryReachability: "online",
        capabilities: null,
        catalog: {
          nodes: [
            {
              nodeId: "desktop",
              reachability: "online",
              catalogError: "catalog unavailable",
            },
          ],
          projects: [],
          providers: [],
        },
      }),
    ).toEqual({ ready: false, reason: "catalog-unavailable" });
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "desktop",
        primaryReachability: "online",
        capabilities: full,
        catalog: {
          nodes: [
            {
              nodeId: "desktop",
              reachability: "online",
              capabilities: full,
              catalogError: "catalog unavailable",
            },
          ],
          projects: [],
          providers: [],
        },
      }),
    ).toEqual({ ready: false, reason: "catalog-unavailable" });
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "desktop",
        primaryReachability: "online",
        capabilities: full,
        catalog: { nodes: [], projects: [], providers: [] },
      }),
    ).toEqual({ ready: false, reason: "catalog-unavailable" });
  });

  it("projects Essentials onto the paired execution node for a Controller primary", () => {
    const controller = {
      preset: "controller" as const,
      ui: true,
      parakeet: true,
      kokoro: true,
      execution: false,
      projects: false,
      providers: false,
    };
    const full = {
      ...controller,
      preset: "full" as const,
      execution: true,
      projects: true,
      providers: true,
    };
    const catalog = {
      nodes: [
        { nodeId: "controller", reachability: "online" as const, capabilities: controller },
        { nodeId: "laptop", reachability: "online" as const, capabilities: full },
      ],
      projects: [{ ref: { nodeId: "laptop", projectId: "jarvis" } }],
      providers: [
        {
          nodeId: "laptop",
          snapshot: {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            availability: "available",
          },
        },
      ],
    } as const;

    expect(
      jarvisOnboardingExecutionNodeId({
        primaryNodeId: "controller",
        primaryReachability: "online",
        capabilities: controller,
        catalog,
      }),
    ).toBe("laptop");
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "controller",
        primaryReachability: "online",
        capabilities: controller,
        catalog,
      }),
    ).toEqual({ ready: true, executionNodeId: "laptop" });
  });

  it("does not choose the first catalog entry when execution candidates tie", () => {
    const full = {
      preset: "full" as const,
      ui: true,
      parakeet: true,
      kokoro: true,
      execution: true,
      projects: true,
      providers: true,
    };
    const catalog = {
      nodes: [
        {
          nodeId: "controller",
          reachability: "online" as const,
          capabilities: {
            ...full,
            execution: false,
            projects: false,
            providers: false,
            preset: "controller" as const,
          },
        },
        { nodeId: "first", reachability: "online" as const, capabilities: full },
        { nodeId: "second", reachability: "online" as const, capabilities: full },
      ],
      projects: [
        { ref: { nodeId: "first", projectId: "one" } },
        { ref: { nodeId: "second", projectId: "two" } },
      ],
      providers: [
        {
          nodeId: "first",
          snapshot: {
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            availability: "available",
          },
        },
        {
          nodeId: "second",
          snapshot: {
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            availability: "available",
          },
        },
      ],
    } as const;
    expect(
      jarvisOnboardingExecutionNodeSelection({
        primaryNodeId: "controller",
        primaryReachability: "online",
        capabilities: catalog.nodes[0]!.capabilities,
        catalog,
      }),
    ).toEqual({ kind: "ambiguous", nodeIds: ["first", "second"] });
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "controller",
        primaryReachability: "online",
        capabilities: catalog.nodes[0]!.capabilities,
        catalog,
      }),
    ).toEqual({ ready: false, reason: "execution-node-ambiguous" });
    expect(
      jarvisOnboardingReadiness({
        primaryNodeId: "controller",
        primaryReachability: "online",
        capabilities: catalog.nodes[0]!.capabilities,
        catalog,
        selectedExecutionNodeId: "second",
      }),
    ).toEqual({ ready: true, executionNodeId: "second" });
  });

  it("scopes completion to environment and preset while migrating the legacy marker once", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    writeJarvisOnboardingCompletion(storage, { environmentId: "node-a", preset: "full" });
    expect(
      readJarvisOnboardingCompletion(storage, { environmentId: "node-a", preset: "full" }),
    ).toBe(true);
    expect(
      readJarvisOnboardingCompletion(storage, { environmentId: "node-b", preset: "full" }),
    ).toBe(false);
    values.set("t3code:jarvis:onboarding:v1", "completed");
    expect(
      readJarvisOnboardingCompletion(storage, { environmentId: "node-c", preset: "full" }),
    ).toBe(true);
    expect(
      readJarvisOnboardingCompletion(storage, { environmentId: "node-d", preset: "full" }),
    ).toBe(false);
  });
});
