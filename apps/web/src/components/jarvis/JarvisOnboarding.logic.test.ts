import { describe, expect, it } from "vite-plus/test";

import {
  canAutoOpenJarvisOnboarding,
  classifyJarvisOnboardingProvider,
  jarvisConnectionRouteLabel,
  jarvisNodeCapabilitySummary,
  jarvisNodePresetLabel,
  jarvisOnboardingProviderStatusLabel,
  jarvisOnboardingReadiness,
  jarvisTailscaleStatus,
  readJarvisOnboardingCompletion,
  writeJarvisOnboardingCompletion,
} from "./JarvisOnboarding.logic";

describe("Jarvis onboarding presentation", () => {
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
    ).toBe("route-detected");
    expect(
      jarvisTailscaleStatus({
        connectionPhase: "connected",
        targetTag: "BearerConnectionTarget",
        displayUrl: "http://100.64.20.7:3773",
      }),
    ).toBe("route-detected");
    expect(
      jarvisTailscaleStatus({
        connectionPhase: "connected",
        targetTag: "PrimaryConnectionTarget",
        displayUrl: null,
      }),
    ).toBe("not-detected");
  });

  it("uses advertised endpoint metadata before falling back to URL shape", () => {
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
  });

  it("does not report false-positive Tailscale hostnames", () => {
    expect(
      jarvisTailscaleStatus({
        connectionPhase: "connected",
        targetTag: "BearerConnectionTarget",
        displayUrl: "https://desktop.ts.net.evil.example",
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

  it("persists only a completion marker", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(readJarvisOnboardingCompletion(storage)).toBe(false);
    writeJarvisOnboardingCompletion(storage);
    expect(readJarvisOnboardingCompletion(storage)).toBe(true);
    expect([...values.values()]).toEqual(["completed"]);
  });
});
