import type {
  AdvertisedEndpoint,
  DesktopJarvisVoiceHelperState,
  JarvisNodeCapabilities,
  ServerProvider,
} from "@t3tools/contracts";
import { SERVER_ENVIRONMENT_LABEL_MAX_LENGTH } from "@t3tools/contracts";

export const JARVIS_ONBOARDING_STORAGE_KEY = "t3code:jarvis:onboarding:v1";

export function jarvisRefreshRequestIsCurrent(input: {
  readonly requestId: number;
  readonly latestRequestId: number;
}): boolean {
  return input.requestId === input.latestRequestId;
}

export function validateJarvisNodeLabel(
  input: string,
):
  | { readonly valid: true; readonly value: string }
  | { readonly valid: false; readonly message: string } {
  const value = input.trim();
  if (value.length === 0) {
    return { valid: false, message: "Enter a device name." };
  }
  if (value.length > SERVER_ENVIRONMENT_LABEL_MAX_LENGTH) {
    return {
      valid: false,
      message: `Device names must be ${SERVER_ENVIRONMENT_LABEL_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { valid: true, value };
}

export const jarvisOnboardingSteps = [
  { id: "device", label: "Device" },
  { id: "essentials", label: "Essentials" },
  { id: "ready", label: "Ready" },
] as const;

export type JarvisOnboardingStepId = (typeof jarvisOnboardingSteps)[number]["id"];

export function jarvisOnboardingStepIndex(step: JarvisOnboardingStepId): number {
  return jarvisOnboardingSteps.findIndex((candidate) => candidate.id === step);
}

export function jarvisOnboardingNextStep(step: JarvisOnboardingStepId): JarvisOnboardingStepId {
  return jarvisOnboardingSteps[
    Math.min(jarvisOnboardingSteps.length - 1, jarvisOnboardingStepIndex(step) + 1)
  ]!.id;
}

export function jarvisOnboardingPreviousStep(step: JarvisOnboardingStepId): JarvisOnboardingStepId {
  return jarvisOnboardingSteps[Math.max(0, jarvisOnboardingStepIndex(step) - 1)]!.id;
}

export function canAutoOpenJarvisOnboarding(input: {
  readonly companionMode: boolean;
  readonly attentionTargetPresent: boolean;
  readonly attemptMade: boolean;
  readonly completionStored: boolean;
}): boolean {
  return (
    !input.companionMode &&
    !input.attentionTargetPresent &&
    !input.attemptMade &&
    !input.completionStored
  );
}

export type JarvisOnboardingProviderStatus = "ready" | "sign-in" | "not-installed" | "attention";

export function classifyJarvisOnboardingProvider(
  provider: Pick<ServerProvider, "enabled" | "installed" | "status" | "auth" | "availability">,
): JarvisOnboardingProviderStatus {
  // Keep this in lockstep with isProviderAvailable: an unavailable driver
  // is a missing setup, while an unauthenticated but installed provider is a
  // sign-in action rather than an unavailable runtime.
  if (provider.availability === "unavailable" || !provider.installed) return "not-installed";
  if (provider.auth.status === "unauthenticated") return "sign-in";
  if (provider.enabled && provider.status === "ready") {
    return "ready";
  }
  return "attention";
}

export function jarvisOnboardingProviderStatusLabel(
  status: JarvisOnboardingProviderStatus,
): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "sign-in":
      return "Sign in";
    case "not-installed":
      return "Not installed";
    case "attention":
      return "Needs attention";
  }
}

export function jarvisNodePresetLabel(preset: JarvisNodeCapabilities["preset"]): string {
  switch (preset) {
    case "full":
      return "Full node";
    case "controller":
      return "Controller node";
    case "headless":
      return "Headless node";
  }
}

export function jarvisNodeCapabilitySummary(capabilities: JarvisNodeCapabilities): string {
  const labels: string[] = [];
  if (capabilities.ui) labels.push("UI");
  if (capabilities.parakeet || capabilities.kokoro) labels.push("voice");
  if (capabilities.execution) labels.push("execution");
  if (capabilities.projects) labels.push("projects");
  if (capabilities.providers) labels.push("providers");
  return labels.join(" · ");
}

export function shouldBootstrapDesktopVoiceHelper(input: {
  readonly isDesktop: boolean;
  readonly capabilities: JarvisNodeCapabilities;
  readonly helperState: Pick<DesktopJarvisVoiceHelperState, "status" | "configured"> | null;
}): boolean {
  return (
    input.isDesktop &&
    input.capabilities.preset === "full" &&
    (input.capabilities.parakeet || input.capabilities.kokoro) &&
    input.helperState !== null &&
    input.helperState.status !== "unavailable" &&
    input.helperState.status !== "error" &&
    !input.helperState.configured
  );
}

export function buildJarvisVoiceHelperPairingUrl(
  httpBaseUrl: string,
  credential: string,
): string | null {
  try {
    const url = new URL("/pair", httpBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = new URLSearchParams({ token: credential }).toString();
    return url.toString();
  } catch {
    return null;
  }
}

type JarvisTailscaleEndpoint = Pick<AdvertisedEndpoint, "provider" | "httpBaseUrl" | "status">;

function normalizedEndpointUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isTailscaleRouteUrl(value: string | null): boolean {
  if (value === null) return false;
  try {
    const hostname = new URL(value).hostname;
    return (
      hostname.endsWith(".ts.net") || /^100\.(?:6[4-9]|[78]\d|1[01]\d|12[0-7])\./u.test(hostname)
    );
  } catch {
    return false;
  }
}

export function jarvisConnectionRouteLabel(input: {
  readonly targetTag: string;
  readonly displayUrl: string | null;
  readonly advertisedEndpoints?: ReadonlyArray<JarvisTailscaleEndpoint>;
}): string {
  if (input.targetTag === "RelayConnectionTarget") return "Relay route";
  if (input.targetTag === "SshConnectionTarget") return "SSH route";
  const matchingEndpoint = input.advertisedEndpoints?.find(
    (endpoint) =>
      input.displayUrl !== null &&
      normalizedEndpointUrl(endpoint.httpBaseUrl) === normalizedEndpointUrl(input.displayUrl),
  );
  if (matchingEndpoint?.provider.id === "tailscale" || isTailscaleRouteUrl(input.displayUrl)) {
    return "Tailscale route";
  }
  if (input.targetTag === "PrimaryConnectionTarget") return "Local route";
  return "Remote route";
}

export type JarvisTailscaleStatus = "route-detected" | "not-detected";

export function jarvisTailscaleStatus(input: {
  readonly connectionPhase: string;
  readonly targetTag: string;
  readonly displayUrl: string | null;
  /** Existing desktop endpoint metadata is stronger than URL-shape inference. */
  readonly advertisedEndpoints?: ReadonlyArray<JarvisTailscaleEndpoint>;
}): JarvisTailscaleStatus {
  if (input.connectionPhase !== "connected") return "not-detected";
  if (input.targetTag === "RelayConnectionTarget" || input.targetTag === "SshConnectionTarget") {
    return "not-detected";
  }

  const matchingEndpoint = input.advertisedEndpoints?.find(
    (endpoint) =>
      input.displayUrl !== null &&
      normalizedEndpointUrl(endpoint.httpBaseUrl) === normalizedEndpointUrl(input.displayUrl),
  );
  if (matchingEndpoint !== undefined) {
    return matchingEndpoint.provider.id === "tailscale" && matchingEndpoint.status === "available"
      ? "route-detected"
      : "not-detected";
  }

  return isTailscaleRouteUrl(input.displayUrl) ? "route-detected" : "not-detected";
}

type JarvisOnboardingProviderSnapshot = Parameters<typeof classifyJarvisOnboardingProvider>[0];

export interface JarvisOnboardingCatalog {
  readonly nodes: ReadonlyArray<{
    readonly nodeId: string;
    readonly reachability: "online" | "offline";
    readonly capabilities?: JarvisNodeCapabilities;
  }>;
  readonly projects: ReadonlyArray<{
    readonly ref: { readonly nodeId: string };
  }>;
  readonly providers: ReadonlyArray<{
    readonly nodeId: string;
    readonly snapshot: JarvisOnboardingProviderSnapshot;
  }>;
}

export type JarvisOnboardingReadinessReason =
  | "connection-required"
  | "execution-node-required"
  | "project-required"
  | "provider-required";

export type JarvisOnboardingReadiness =
  | { readonly ready: true; readonly executionNodeId: string }
  | { readonly ready: false; readonly reason: JarvisOnboardingReadinessReason };

function hasProject(catalog: JarvisOnboardingCatalog, nodeId: string): boolean {
  return catalog.projects.some((project) => project.ref.nodeId === nodeId);
}

function hasReadyProvider(catalog: JarvisOnboardingCatalog, nodeId: string): boolean {
  return catalog.providers.some(
    (provider) =>
      provider.nodeId === nodeId && classifyJarvisOnboardingProvider(provider.snapshot) === "ready",
  );
}

/** Selects the node whose resources Essentials should describe and whose readiness can satisfy Jarvis. */
export function jarvisOnboardingExecutionNodeId(input: {
  readonly primaryNodeId: string;
  readonly primaryReachability: "online" | "offline";
  readonly capabilities: JarvisNodeCapabilities;
  readonly catalog: JarvisOnboardingCatalog;
}): string | null {
  if (input.primaryReachability !== "online") return null;
  if (input.capabilities.execution && input.capabilities.projects && input.capabilities.providers) {
    return (
      input.catalog.nodes.find(
        (node) => node.nodeId === input.primaryNodeId && node.reachability === "online",
      )?.nodeId ?? null
    );
  }
  return (
    input.catalog.nodes.find(
      (node) =>
        node.nodeId !== input.primaryNodeId &&
        node.reachability === "online" &&
        node.capabilities?.execution === true,
    )?.nodeId ?? null
  );
}

export function jarvisOnboardingReadiness(input: {
  readonly primaryNodeId: string;
  readonly primaryReachability: "online" | "offline";
  readonly capabilities: JarvisNodeCapabilities;
  readonly catalog: JarvisOnboardingCatalog;
}): JarvisOnboardingReadiness {
  if (input.primaryReachability !== "online") {
    return { ready: false, reason: "connection-required" };
  }

  const executionNodeId = jarvisOnboardingExecutionNodeId(input);
  if (executionNodeId === null) {
    return { ready: false, reason: "execution-node-required" };
  }
  if (!hasProject(input.catalog, executionNodeId)) {
    return { ready: false, reason: "project-required" };
  }
  if (!hasReadyProvider(input.catalog, executionNodeId)) {
    return { ready: false, reason: "provider-required" };
  }
  return { ready: true, executionNodeId };
}

export function readJarvisOnboardingCompletion(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(JARVIS_ONBOARDING_STORAGE_KEY) === "completed";
  } catch {
    return false;
  }
}

export function writeJarvisOnboardingCompletion(storage: Pick<Storage, "setItem">): void {
  try {
    storage.setItem(JARVIS_ONBOARDING_STORAGE_KEY, "completed");
  } catch {
    // A blocked localStorage should not prevent the user from using Jarvis.
  }
}
